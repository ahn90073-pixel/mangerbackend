const SHA512CRYPT_ROUNDS = 500_000;
const SHA512CRYPT_PREFIX = `$6$rounds=${SHA512CRYPT_ROUNDS}$`;

export async function hashPassword(db, password) {
  const [row] = await db.query(
    `SELECT crypt($1::text, gen_salt('sha512crypt', ${SHA512CRYPT_ROUNDS})) AS password_hash`,
    [password],
  );
  if (typeof row?.password_hash !== 'string' || !row.password_hash.startsWith(SHA512CRYPT_PREFIX)) {
    throw new Error('Password hashing failed.');
  }
  return row.password_hash;
}

export async function verifyPassword(db, password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !stored.startsWith(SHA512CRYPT_PREFIX)) {
    return false;
  }
  const [row] = await db.query(
    'SELECT crypt($1::text, $2::text) = $2::text AS valid',
    [password, stored],
  );
  return row?.valid === true;
}
