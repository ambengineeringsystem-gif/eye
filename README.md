Viewer site (caller)

Overview
- This page is the viewer/caller. It creates a random Call ID, writes a WebRTC offer to `/calls/<callId>/offer`, and waits for the camera to write the answer at `/calls/<callId>/answer`.

Setup
1. Create a Firebase project and enable Realtime Database.
2. Create a Web App in Firebase and copy the config object.
3. Provide the config object to the page. You can do one of:
	- Paste it directly in `viewer/main.js` by filling the `embeddedConfig` object near the top of the file.
	- Open the page and paste the config JSON into the prompt that appears (it will be saved to `localStorage` under key `firebaseConfig`).
	- Manually store a JSON string under `localStorage['firebaseConfig']`.
4. Make sure your Realtime Database rules allow read/write for testing or configure proper auth.

Run locally
```powershell
# from c:\Users\user\Desktop\SECU
python -m http.server 8080
# then open http://localhost:8080/viewer/
```

How to use
- Click "Create Call". Copy the Call ID and paste it into the cam page's input. The cam will auto-answer and the remote video will appear here.

Security note
- This is a demo. Do not use permissive database rules in production. Add authentication and secure rules.
