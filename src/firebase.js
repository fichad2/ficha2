import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBG4eYSv2JPqga0HBvJu7nPTg0tOGMUz78",
  authDomain: "fichad2.firebaseapp.com",
  projectId: "fichad2",
  storageBucket: "fichad2.appspot.com",
  messagingSenderId: "330033367999",
  appId: "1:330033367999:web:2e9e50cde71c0d7706af0a"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true") {
  const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "127.0.0.1";

  connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulatorHost, 8080);
}
