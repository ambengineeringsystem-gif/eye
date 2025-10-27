Cam site (auto-answering callee)

Overview
- This page runs on the camera side. It asks for camera/microphone access and will auto-answer a WebRTC offer written by the viewer into the Firebase Realtime Database.

How it works
- Viewer creates a Call ID and writes an offer to `/calls/<callId>/offer`.
- Cam listens for that offer at `/calls/<callId>` and, when present, sets it as remote description, creates an answer, and writes `/calls/<callId>/answer`.
- Both sides exchange ICE candidates via `/calls/<callId>/callerCandidates` and `/calls/<callId>/calleeCandidates`.

Setup
1. Create a Firebase project and enable Realtime Database.
2. Create a Web App in Firebase and copy the config object.
3. Provide the config object to the page. You can do one of:
	- Paste it directly in `cam/main.js` by filling the `embeddedConfig` object near the top of the file.
	- Open the page and paste the config JSON into the prompt that appears (it will be saved to `localStorage` under key `firebaseConfig`).
	- Manually store a JSON string under `localStorage['firebaseConfig']`.
4. Make sure your Realtime Database rules allow read/write for test (e.g., set to true) or configure auth.

Run locally
- Serve this folder with a static server (Live Server extension or python simple server):

```powershell
# from c:\Users\user\Desktop\SECU
python -m http.server 8080
# then open http://localhost:8080/cam/
```

Security note
- This example is for testing. Do NOT use permissive DB rules in production. Add authentication and tighten rules.
