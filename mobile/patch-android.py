"""Run after `npx cap add android`: adds microphone permissions and lets the app find the tablet's speech recognizer."""
import re, sys
p = 'android/app/src/main/AndroidManifest.xml'
s = open(p).read()
perms = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.INTERNET']
add = ''.join('    <uses-permission android:name="%s" />\n' % x for x in perms if x not in s)
if 'android.speech.RecognitionService' not in s:
    add += '    <queries>\n        <intent>\n            <action android:name="android.speech.RecognitionService" />\n        </intent>\n    </queries>\n'
assert '</manifest>' in s
s = s.replace('</manifest>', add + '</manifest>')
# landscape or portrait, keep the screen awake is handled in the page; nothing else changed here
open(p, 'w').write(s)

# Sign every test build with the same key, so a new build installs over the old one and keeps the child's words and photos.
g = 'android/app/build.gradle'
t = open(g).read()
if 'myturnTest' not in t:
    t = t.replace('    buildTypes {', "    signingConfigs {\n        myturnTest {\n            storeFile file('../../test.keystore')\n            storePassword 'myturn-test'\n            keyAlias 'myturn'\n            keyPassword 'myturn-test'\n        }\n    }\n    buildTypes {\n        debug {\n            signingConfig signingConfigs.myturnTest\n        }", 1)
    assert 'myturnTest' in t
    open(g, 'w').write(t)
print('android project patched')
