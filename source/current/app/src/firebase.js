import { initializeApp } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  setPersistence,
  signInWithCredential,
  signInWithRedirect,
  signOut,
} from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'PRIVATE_VALUE_007',
  authDomain: 'PRIVATE_VALUE_011',
  projectId: 'siparis-takip-70e85',
  storageBucket: 'siparis-takip-70e85.firebasestorage.app',
  messagingSenderId: '381265617199',
  appId: '1:381265617199:web:596d499a102fb57f1f01da',
}

const firebaseApp = initializeApp(firebaseConfig)
const auth = getAuth(firebaseApp)
const db = getFirestore(firebaseApp)
const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

setPersistence(auth, browserLocalPersistence).catch(() => {
  // Firebase uygun geri dönüş mekanizmasını kendisi uygular.
})

async function loginWithGoogle() {
  if (window.siparisTakip?.googleLogin) {
    const tokens = await window.siparisTakip.googleLogin()
    const credential = GoogleAuthProvider.credential(tokens?.idToken || null, tokens?.accessToken || null)
    return signInWithCredential(auth, credential)
  }
  return signInWithRedirect(auth, googleProvider)
}

function completeGoogleRedirect() {
  return getRedirectResult(auth)
}

function logout() {
  return signOut(auth)
}

export { auth, completeGoogleRedirect, db, loginWithGoogle, logout }
