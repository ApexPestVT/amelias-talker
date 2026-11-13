# My Turn tablet app (test builds)

This folder wraps the web app in `../public` as an Android app (iPad later) using Capacitor.

- GitHub builds it on every push that touches `public/` or `mobile/` and puts **MyTurn-test.apk** on the
  "Android test build" release page.
- `test.keystore` signs TEST builds only, so each new build installs over the last one. It is public on purpose.
  **Never use it for a Play Store release.** A store release needs its own private key.
- The app id `app.myturn.talker` becomes permanent once the app is published in a store. Change it before then if wanted.
- Inside the app the tablet's own speech recognition is used for listening (free). The paid service stays as a
  switch in the lock menu.
