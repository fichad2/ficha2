import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

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