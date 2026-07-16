import { describe, expect, it } from 'vitest';
import { dbIdentityKey, findRemoteDuplicates } from '../src/shared/dbIdentity.js';

describe('dbIdentityKey', () => {
  it('unifies loopback aliases', () => {
    const a = dbIdentityKey('postgresql://u@localhost:5432/db');
    expect(a).toBe(dbIdentityKey('postgresql://u@127.0.0.1:5432/db'));
    expect(a).toBe(dbIdentityKey('postgresql://u@[::1]:5432/db'));
  });

  it('defaults the port to 5432', () => {
    expect(dbIdentityKey('postgresql://u@h/db')).toBe(dbIdentityKey('postgresql://u@h:5432/db'));
  });

  it('distinguishes host, port, and database', () => {
    const base = dbIdentityKey('postgresql://u@h:5432/db');
    expect(dbIdentityKey('postgresql://u@other:5432/db')).not.toBe(base);
    expect(dbIdentityKey('postgresql://u@h:5433/db')).not.toBe(base);
    expect(dbIdentityKey('postgresql://u@h:5432/other')).not.toBe(base);
  });

  it('ignores user, password, schemas, and query params', () => {
    const base = dbIdentityKey('postgresql://u@h:5432/db');
    expect(dbIdentityKey('postgresql://someone-else@h:5432/db')).toBe(base);
    expect(dbIdentityKey('postgresql://u:pw@h:5432/db?sslmode=require')).toBe(base);
  });

  it('is case-insensitive on the host', () => {
    expect(dbIdentityKey('postgresql://u@DB.Example.COM/db')).toBe(dbIdentityKey('postgresql://u@db.example.com/db'));
  });

  it('returns null for unparseable or non-postgres URLs', () => {
    expect(dbIdentityKey('not a url')).toBeNull();
    expect(dbIdentityKey('https://example.com/db')).toBeNull();
  });

  it('returns null for an empty dbname (libpq defaults it to the username)', () => {
    // alice@h/ and bob@h/ connect to databases "alice" and "bob" — keying
    // them equal would be a false duplicate match.
    expect(dbIdentityKey('postgresql://alice@h:5432/')).toBeNull();
    expect(dbIdentityKey('postgresql://bob@h:5432')).toBeNull();
  });

  it('returns null for identity-bearing query params and an empty host', () => {
    expect(dbIdentityKey('postgresql://u@h/db?host=other')).toBeNull();
    expect(dbIdentityKey('postgresql://u@h/db?hostaddr=10.0.0.1')).toBeNull();
    expect(dbIdentityKey('postgresql://u@h/db?port=6432')).toBeNull();
    expect(dbIdentityKey('postgresql://u@h/db?dbname=other')).toBeNull();
    expect(dbIdentityKey('postgresql://?dbname=x&host=h1')).toBeNull();
  });

  it('percent-decodes the dbname so encoded and literal forms compare equal', () => {
    expect(dbIdentityKey('postgresql://u@h/db%41')).toBe(dbIdentityKey('postgresql://u@h/dbA'));
    expect(dbIdentityKey('postgresql://u@h/db%')).toBeNull();
  });
});

describe('findRemoteDuplicates', () => {
  const profiles = [
    { name: 'declared-same', url: 'postgresql://u@127.0.0.1/db', remoteMcp: { declared: true } },
    { name: 'declared-other-db', url: 'postgresql://u@localhost/other', remoteMcp: { declared: true } },
    { name: 'undeclared-same', url: 'postgresql://u@localhost/db' },
  ];

  it('matches only declared profiles with the same database identity', () => {
    expect(findRemoteDuplicates(profiles, 'postgresql://another@localhost:5432/db')).toEqual(['declared-same']);
  });

  it('returns nothing for a different database or an unparseable target', () => {
    expect(findRemoteDuplicates(profiles, 'postgresql://u@localhost/third')).toEqual([]);
    expect(findRemoteDuplicates(profiles, 'nonsense')).toEqual([]);
  });
});
