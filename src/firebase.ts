import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getAnalytics } from 'firebase/analytics';

const firebaseConfig = {
  apiKey: "AIzaSyD55-qa7l3mumHB3sTciw1P8xRf4moAUhs",
  authDomain: "roulette-diy.firebaseapp.com",
  projectId: "roulette-diy",
  storageBucket: "roulette-diy.firebasestorage.app",
  messagingSenderId: "210783514149",
  appId: "1:210783514149:web:9c9f90b31f56c052cd59cc",
  measurementId: "G-PW5SH1M2HK",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const analytics = getAnalytics(app);
export const googleProvider = new GoogleAuthProvider();
