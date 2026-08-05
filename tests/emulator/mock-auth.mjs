/** Doble de firebase-admin/auth para las pruebas contra el emulador. */
export const getAuth = () => ({
  verifyIdToken: async () => ({
    uid: process.env.MOCK_UID || 'usuario-prueba',
    email: 'prueba@ejemplo.com',
    email_verified: true
  })
});
