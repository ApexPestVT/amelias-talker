"""Run after `npx cap add ios`: adds the microphone and speech permissions and our own listening and voice helper."""
import io, os, plistlib, re, sys

app = 'ios/App/App'

# 1. Why the app asks for the microphone and for speech recognition (shown by iOS the first time).
p = os.path.join(app, 'Info.plist')
with open(p, 'rb') as f:
    info = plistlib.load(f)
info['NSMicrophoneUsageDescription'] = 'My Turn listens for questions people ask, so it can offer answers to tap.'
info['NSSpeechRecognitionUsageDescription'] = 'My Turn turns the questions it hears into words, so it can offer answers to tap.'
info['ITSAppUsesNonExemptEncryption'] = False
with open(p, 'wb') as f:
    plistlib.dump(info, f)

# 2. Our helper is added to the end of AppDelegate.swift, which is already part of the Xcode project,
#    so the project file itself does not have to be edited.
d = os.path.join(app, 'AppDelegate.swift')
s = io.open(d, encoding='utf-8').read()
if 'TabletSpeechPlugin' not in s:
    s = s.rstrip('\n') + '\n\n' + io.open('native/ios/TabletSpeech.swift', encoding='utf-8').read()
    io.open(d, 'w', encoding='utf-8').write(s)

# 3. The main screen becomes our MainViewController, which makes the helper known to the page.
b = os.path.join(app, 'Base.lproj', 'Main.storyboard')
t = io.open(b, encoding='utf-8').read()
if 'MainViewController' not in t:
    n = re.subn(r'customClass="CAPBridgeViewController"(\s+customModule="Capacitor")?',
                'customClass="MainViewController" customModule="App" customModuleProvider="target"', t)
    if n[1] != 1:
        sys.exit('Main.storyboard does not look as expected:\n' + t)
    io.open(b, 'w', encoding='utf-8').write(n[0])

# 4. The My Turn icon and launch screen replace the wrapper's stock ones.
import glob, shutil
icons = glob.glob(os.path.join(app, 'Assets.xcassets', 'AppIcon.appiconset', '*.png'))
if len(icons) != 1:
    sys.exit('Expected one app icon file in the template, found: %r' % icons)
shutil.copyfile('native/ios/AppIcon-1024.png', icons[0])
splashes = glob.glob(os.path.join(app, 'Assets.xcassets', 'Splash.imageset', '*.png'))
if not splashes:
    sys.exit('No launch screen pictures found in the template')
for f in splashes:
    shutil.copyfile('native/ios/Splash-2732.png', f)

print('ios project patched (icon 1, launch pictures %d)' % len(splashes))
