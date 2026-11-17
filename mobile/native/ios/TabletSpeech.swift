// ---- My Turn: listening and talking on iPad and iPhone ----
// This file is added to the end of the app's AppDelegate.swift by patch-ios.py, so it needs no changes to the Xcode project.
//
// It gives the page the same helper the Android app has ("TabletSpeech"):
//   start / stop            listening, as one long session (no beeps, no restart per sentence)
//   speak / stopSpeaking    the device's own voice
//   voiceStatus             for the Listening check screen
// Events sent to the page: partialResults {matches}, final {text}, beat {}, listeningState {status, engine, error}.

import Foundation
import UIKit
import Capacitor
import Speech
import AVFoundation

/// The app's main screen. Its only job here is to make the helper below known to the page.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TabletSpeechPlugin())
    }
}

@objc(TabletSpeechPlugin)
public class TabletSpeechPlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "TabletSpeechPlugin"
    public let jsName = "TabletSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voiceStatus", returnType: CAPPluginReturnPromise)
    ]

    // ---- listening ----
    private let audio = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let lock = NSLock()
    private var running = false
    private var onDevice = false
    private var engineName = "none"
    private var generation = 0                 // every new sentence gets a number, so late answers for an old one are ignored
    private var lastText = ""
    private var lastChange = Date()
    private var segmentStart = Date()
    private var lastBeat = Date.distantPast
    private var lastBuffer = Date.distantPast   // guarded by lock: written on the sound thread
    private var troubles = 0
    private var timer: Timer?
    private var watching = false

    private static let pauseEndsSentence: TimeInterval = 1.1   // this long with no new words = the sentence is finished
    private static let quietRestart: TimeInterval = 45         // Apple's servers allow about a minute per request
    private static let longestSentence: TimeInterval = 50

    // ---- talking ----
    private let synth = AVSpeechSynthesizer()
    private var speakCalls: [ObjectIdentifier: CAPPluginCall] = [:]

    override public func load() {
        synth.delegate = self
        // An AAC app must talk even when the ring/silent switch is set to silent.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
    }

    // MARK: listening

    @objc func start(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("speech recognition not allowed")
                return
            }
            let afterMic: (Bool) -> Void = { granted in
                DispatchQueue.main.async {
                    if granted { self.begin(call) } else { call.reject("microphone not allowed") }
                }
            }
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission(completionHandler: afterMic)
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission(afterMic)
            }
        }
    }

    private func begin(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "en-US"
        let wantDevice = call.getBool("onDevice") ?? true
        stopListening()
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: language)), rec.isAvailable else {
            call.reject("no speech recognizer on this device")
            return
        }
        recognizer = rec
        onDevice = wantDevice && rec.supportsOnDeviceRecognition
        engineName = onDevice ? "on-device, one long session" : "Apple speech service, one long session"
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true, options: [])
            let input = audio.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                call.reject("the microphone gave no sound format")
                return
            }
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self = self else { return }
                self.lock.lock()
                self.lastBuffer = Date()
                let req = self.request
                self.lock.unlock()
                req?.append(buffer)
            }
            audio.prepare()
            try audio.start()
        } catch {
            stopListening()
            call.reject("microphone could not start: \(error.localizedDescription)")
            return
        }
        running = true
        troubles = 0
        watch()
        newSentence()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.tick() }
        call.resolve(["engine": engineName])
        state("started", 0)
    }

    /// Start waiting for the next sentence. The microphone keeps running; only the request to the recognizer is new.
    private func newSentence() {
        guard running, let rec = recognizer else { return }
        task?.cancel()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if onDevice { req.requiresOnDeviceRecognition = true }
        if #available(iOS 16.0, *) { req.addsPunctuation = true }
        lock.lock()
        request = req
        lock.unlock()
        generation += 1
        let mine = generation
        lastText = ""
        segmentStart = Date()
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async { self?.heard(mine, result, error) }
        }
    }

    private func heard(_ mine: Int, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
        guard running, mine == generation else { return }
        if let r = result {
            let text = r.bestTranscription.formattedString
            if text != lastText {
                lastText = text
                lastChange = Date()
                if !text.isEmpty { notifyListeners("partialResults", data: ["matches": [text]]) }
            }
            if r.isFinal { finishSentence(); return }
        }
        if error != nil {
            if !lastText.isEmpty { finishSentence(); return }
            // Nothing was said, or the recognizer gave up on this request. Try again; give up only if it keeps failing.
            troubles += 1
            if troubles > 6 {
                let code = (error as NSError?)?.code ?? 1
                stopListening()
                state("stopped", code == 0 ? 1 : code)
            } else {
                newSentence()
            }
        }
    }

    private func finishSentence() {
        let text = lastText
        lastText = ""
        troubles = 0
        if !text.isEmpty { notifyListeners("final", data: ["text": text]) }
        newSentence()
    }

    private func tick() {
        guard running else { return }
        let now = Date()
        lock.lock()
        let fresh = now.timeIntervalSince(lastBuffer) < 1.5
        lock.unlock()
        if fresh && now.timeIntervalSince(lastBeat) > 2 {          // proof of life for the page, only while sound is arriving
            lastBeat = now
            notifyListeners("beat", data: [:])
        }
        if !lastText.isEmpty {
            if now.timeIntervalSince(lastChange) > TabletSpeechPlugin.pauseEndsSentence || now.timeIntervalSince(segmentStart) > TabletSpeechPlugin.longestSentence {
                finishSentence()
            }
        } else if now.timeIntervalSince(segmentStart) > TabletSpeechPlugin.quietRestart {
            newSentence()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopListening()
            call.resolve()
        }
    }

    private func stopListening() {
        running = false
        generation += 1
        timer?.invalidate()
        timer = nil
        audio.inputNode.removeTap(onBus: 0)
        if audio.isRunning { audio.stop() }
        lock.lock()
        let req = request
        request = nil
        lock.unlock()
        req?.endAudio()
        task?.cancel()
        task = nil
        lastText = ""
    }

    /// A phone call, Siri, or a change of headphones stops the microphone. Tell the page, which starts listening again.
    private func watch() {
        if watching { return }
        watching = true
        let centre = NotificationCenter.default
        centre.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self, self.running else { return }
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            if raw == AVAudioSession.InterruptionType.began.rawValue {
                self.stopListening()
                self.state("stopped", 7)        // 7 = quiet stop: the page restarts without counting it as a failure
            }
        }
        centre.addObserver(forName: .AVAudioEngineConfigurationChange, object: audio, queue: .main) { [weak self] _ in
            guard let self = self, self.running else { return }
            self.stopListening()
            self.state("stopped", 7)
        }
    }

    private func state(_ status: String, _ error: Int) {
        var data: [String: Any] = ["status": status, "engine": engineName]
        if error != 0 { data["error"] = error }
        notifyListeners("listeningState", data: data)
    }

    // MARK: talking

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let rate = call.getFloat("rate") ?? 1
        let pitch = call.getFloat("pitch") ?? 1
        if text.isEmpty { call.resolve(); return }
        DispatchQueue.main.async {
            if self.synth.isSpeaking { self.synth.stopSpeaking(at: .immediate) }
            let u = AVSpeechUtterance(string: text)
            u.voice = AVSpeechSynthesisVoice(language: "en-US")
            u.rate = min(max(AVSpeechUtteranceDefaultSpeechRate * rate, 0.3), 0.6)
            u.pitchMultiplier = min(max(pitch, 0.5), 2)
            self.speakCalls[ObjectIdentifier(u)] = call
            self.synth.speak(u)
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.synth.isSpeaking { self.synth.stopSpeaking(at: .immediate) }
            call.resolve()
        }
    }

    @objc func voiceStatus(_ call: CAPPluginCall) {
        let volume = AVAudioSession.sharedInstance().outputVolume
        call.resolve([
            "ready": true,
            "engine": "iOS voice",
            "mediaVolume": Int((volume * 100).rounded()),
            "mediaMax": 100,
            "mediaMuted": false
        ])
    }

    private func spoken(_ utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            if let call = self.speakCalls.removeValue(forKey: ObjectIdentifier(utterance)) { call.resolve() }
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { spoken(utterance) }
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { spoken(utterance) }
}
