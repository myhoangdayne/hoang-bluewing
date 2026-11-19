/*
 * BlueWing Firebase configuration
 * 1) Tạo Firebase project: https://console.firebase.google.com/
 * 2) Add Web App, copy firebaseConfig và điền các giá trị bên dưới.
 * 3) Bật Authentication > Sign-in method > Google.
 * 4) Tạo Cloud Firestore database.
 * Không đưa service-account/private key vào file này.
 */
window.BLUEWING_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDvgSQ6Hj0ogvLTIoIXqBzYDXfUjdt5yuk",
  authDomain: "vact-kimhoang.firebaseapp.com",
  projectId: "vact-kimhoang",
  storageBucket: "vact-kimhoang.firebasestorage.app",
  messagingSenderId: "864833005111",
  appId: "1:864833005111:web:a664bbc711f09892d001b2"
};
if ($('screen-result').classList.contains('active')) renderResult();
if ($('screen-intro').classList.contains('active')) renderIntro();