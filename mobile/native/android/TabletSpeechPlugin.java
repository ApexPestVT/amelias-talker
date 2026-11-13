package app.myturn.talker;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;

/**
 * Listening for My Turn, written to avoid the start/stop beeps of the standard recognizer.
 *
 * 1. Where the tablet has its own on-device recognizer (Android 12+), that one is used. On Android 13+ it is asked
 *    for one long "segmented" session, so it does not have to be restarted after every sentence.
 * 2. Otherwise the standard recognizer is used and the tablet's sounds are muted for a moment around each start.
 *
 * Events sent to the page: partialResults {matches}, final {text}, beat {}, listeningState {status, engine, error}.
 */
@CapacitorPlugin(
    name = "TabletSpeech",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class TabletSpeechPlugin extends Plugin implements RecognitionListener {

    private SpeechRecognizer rec;
    private Intent lastIntent;
    private String engine = "none";
    private boolean segmented = false;
    private boolean muted = false;
    private long lastBeat = 0;
    private final Handler main = new Handler(Looper.getMainLooper());
    private static final int[] QUIET_STREAMS = { AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM };

    // ---- talking: the tablet's own voice. A web page inside an Android app cannot use the browser's voice. ----
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile boolean speakingNow = false;
    private int utterance = 0;
    private final HashMap<String, PluginCall> speakCalls = new HashMap<>();

    @Override
    public void load() {
        try {
            tts = new TextToSpeech(getContext(), status -> {
                ttsReady = (status == TextToSpeech.SUCCESS);
                if (!ttsReady) return;
                try { tts.setLanguage(Locale.US); } catch (Exception ignored) {}
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { speakingNow = true; }
                    @Override public void onDone(String id) { finishSpeak(id, null); }
                    @Override public void onError(String id) { finishSpeak(id, "voice error"); }
                    @Override public void onStop(String id, boolean interrupted) { finishSpeak(id, null); }
                });
            });
        } catch (Exception ignored) {}
    }

    private void finishSpeak(String id, String err) {
        PluginCall c;
        synchronized (speakCalls) {
            c = speakCalls.remove(id);
            speakingNow = !speakCalls.isEmpty();
        }
        if (c == null) return;
        if (err == null) c.resolve(); else c.reject(err);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        Float rate = call.getFloat("rate", 1f);
        Float pitch = call.getFloat("pitch", 1f);
        if (tts == null || !ttsReady) { call.reject("voice not ready"); return; }
        if (text == null || text.length() == 0) { call.resolve(); return; }
        main.removeCallbacks(unquietLater);
        unquiet();                                   // never talk into a muted tablet
        String id = "u" + (++utterance);
        synchronized (speakCalls) { speakCalls.put(id, call); }
        try {
            tts.setSpeechRate(rate == null ? 1f : rate);
            tts.setPitch(pitch == null ? 1f : pitch);
            speakingNow = true;
            int r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
            if (r != TextToSpeech.SUCCESS) finishSpeak(id, "voice could not start");
        } catch (Exception ex) {
            finishSpeak(id, String.valueOf(ex.getMessage()));
        }
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        try { if (tts != null) tts.stop(); } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void voiceStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ready", ttsReady);
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                ret.put("mediaVolume", am.getStreamVolume(AudioManager.STREAM_MUSIC));
                ret.put("mediaMax", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
                ret.put("mediaMuted", am.isStreamMute(AudioManager.STREAM_MUSIC));
            }
            if (tts != null && ttsReady) ret.put("engine", String.valueOf(tts.getDefaultEngine()));
        } catch (Exception ignored) {}
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micResult");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else call.reject("microphone not allowed");
    }

    private void begin(final PluginCall call) {
        final String language = call.getString("language", "en-US");
        final boolean wantDevice = Boolean.TRUE.equals(call.getBoolean("onDevice", true));
        main.post(() -> {
            try {
                Context ctx = getContext();
                if (rec != null) {
                    try { rec.cancel(); rec.destroy(); } catch (Exception ignored) {}
                    rec = null;
                }
                boolean onDevice = wantDevice && Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx);
                if (onDevice) rec = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx);
                else {
                    if (!SpeechRecognizer.isRecognitionAvailable(ctx)) { call.reject("no speech recognizer on this tablet"); return; }
                    rec = SpeechRecognizer.createSpeechRecognizer(ctx);
                }
                segmented = onDevice && Build.VERSION.SDK_INT >= 33;
                engine = onDevice ? (segmented ? "on-device, one long session" : "on-device") : "standard (sounds muted at start)";

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
                if (segmented) {
                    intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS);
                    intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 30000);
                    intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200);
                }
                lastIntent = intent;
                quiet(!onDevice);
                rec.setRecognitionListener(this);
                rec.startListening(intent);
                JSObject ret = new JSObject();
                ret.put("engine", engine);
                call.resolve(ret);
            } catch (Exception ex) {
                unquiet();
                call.reject(String.valueOf(ex.getMessage()));
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            try {
                if (rec != null) { quiet(!engine.startsWith("on-device")); rec.cancel(); rec.destroy(); rec = null; }
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    /** Mute the tablet's alert sounds (and, for the standard recognizer, its media sound) for a moment. */
    private void quiet(boolean alsoMedia) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            for (int s : QUIET_STREAMS) { try { am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, 0); } catch (Exception ignored) {} }
            if (alsoMedia && !speakingNow) { try { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0); } catch (Exception ignored) {} }
            muted = true;
            main.removeCallbacks(unquietLater);
            main.postDelayed(unquietLater, 700);
        } catch (Exception ignored) {}
    }

    private final Runnable unquietLater = this::unquiet;

    private void unquiet() {
        if (!muted) return;
        muted = false;
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            for (int s : QUIET_STREAMS) { try { am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0); } catch (Exception ignored) {} }
            try { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0); } catch (Exception ignored) {}
        } catch (Exception ignored) {}
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        main.removeCallbacks(unquietLater);
        unquiet();
    }

    @Override
    protected void handleOnDestroy() {
        main.removeCallbacks(unquietLater);
        unquiet();
        try { if (rec != null) { rec.cancel(); rec.destroy(); rec = null; } } catch (Exception ignored) {}
        try { if (tts != null) { tts.stop(); tts.shutdown(); tts = null; } } catch (Exception ignored) {}
        super.handleOnDestroy();
    }

    private String first(Bundle b) {
        if (b == null) return "";
        ArrayList<String> m = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (m != null && m.size() > 0 && m.get(0) != null) ? m.get(0) : "";
    }

    private void state(String status, int error) {
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("engine", engine);
        if (error != 0) ret.put("error", error);
        notifyListeners("listeningState", ret);
    }

    private void sendFinal(Bundle b) {
        String t = first(b);
        if (t.length() == 0) return;
        JSObject ret = new JSObject();
        ret.put("text", t);
        notifyListeners("final", ret);
    }

    // ---- RecognitionListener ----
    @Override public void onReadyForSpeech(Bundle params) { state("started", 0); }
    @Override public void onBeginningOfSpeech() {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEvent(int eventType, Bundle params) {}

    @Override
    public void onRmsChanged(float rmsdB) {           // proof of life for the page, at most every 2 seconds
        long now = System.currentTimeMillis();
        if (now - lastBeat > 2000) { lastBeat = now; notifyListeners("beat", new JSObject()); }
    }

    @Override public void onEndOfSpeech() {}

    @Override
    public void onPartialResults(Bundle partialResults) {
        String t = first(partialResults);
        if (t.length() == 0) return;
        JSArray arr = new JSArray();
        arr.put(t);
        JSObject ret = new JSObject();
        ret.put("matches", arr);
        notifyListeners("partialResults", ret);
    }

    @Override
    public void onSegmentResults(Bundle segmentResults) { sendFinal(segmentResults); }

    @Override
    public void onEndOfSegmentedSession() { state("stopped", 0); }

    @Override
    public void onResults(Bundle results) {
        sendFinal(results);
        if (!segmented) state("stopped", 0);
    }

    @Override
    public void onError(int error) {
        // 12 and 13: the on-device language pack is missing. Ask the tablet to fetch it (Android 13+).
        if ((error == 12 || error == 13) && Build.VERSION.SDK_INT >= 33 && rec != null && lastIntent != null) {
            try { rec.triggerModelDownload(lastIntent); } catch (Exception ignored) {}
        }
        state("stopped", error);
    }
}
