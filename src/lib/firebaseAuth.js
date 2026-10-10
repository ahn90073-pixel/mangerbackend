export async function lookupFirebaseGoogleUser(idToken, apiKey, fetchImpl = fetch) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 12000) {
    return null
  }
  const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  })
  if (!response.ok) return null
  const result = await response.json().catch(() => null)
  const user = result?.users?.[0]
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : ''
  const hasGoogleProvider = Array.isArray(user?.providerUserInfo)
    && user.providerUserInfo.some((provider) => provider?.providerId === 'google.com')
  if (!user?.localId || !email || user.emailVerified !== true || user.disabled === true || !hasGoogleProvider) return null
  return {
    uid: user.localId,
    email,
    fullName: typeof user.displayName === 'string' ? user.displayName.trim().slice(0, 160) : '',
  }
}
