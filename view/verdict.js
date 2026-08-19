// The three answers a deletion can give, and the only vocabulary the consent
// and wipe paths speak in.
//
// Second-member review, round 2 (HIGH). Round 1 made every durable operation
// verify by RE-READ, which killed the "it did not throw, so it worked" class -
// but it kept a boolean, and a boolean has no room for the third answer. So
// "the storage could not be listed" and "the storage could not be read" both
// collapsed into `true`: an unverifiable wipe reported success, announced
// `data reset`, and the keys were all still there when the storage recovered.
//
// "I cannot see" is not "it is gone". Three outcomes, and only ONE of them is
// evidence of absence:
//
//   CLEARED  read back, and the key is not there. The only success.
//   REMAINS  read back, and the key IS there. A failure that was witnessed.
//   UNKNOWN  could not be read or listed at all. Not a failure - not a success
//            either, which is the whole point: nothing may be claimed from it.
//
// Its own module because both storage-facing modules need it and neither can
// import the other (view/telemetry.js already imports readBest from
// view/save.js). One home, so the two halves of the wipe's verdict cannot
// drift into two vocabularies - the drift the row-16 namespace pin exists for.
export const CLEARED = 'cleared';
export const REMAINS = 'remains';
export const UNKNOWN = 'unknown';

// REMAINS outranks UNKNOWN only for REPORTING: a sweep that watched a key
// survive knows more than one that could not look, and the aria string and the
// ledger may as well say which. Neither is done, and no caller is allowed to
// treat the difference as a degree of success.
const RANK = { [CLEARED]: 0, [UNKNOWN]: 1, [REMAINS]: 2 };

/**
 * Anything that is not one of the three is UNKNOWN, never CLEARED: a caller
 * that forgot to return, an old boolean from before this vocabulary existed, a
 * typo'd string. The strictness round 1 got from `=== true`, kept - and now the
 * dangerous direction (an unexamined truthy value) fails closed rather than
 * reading as a success.
 */
export function asVerdict(v) {
  return v === CLEARED || v === REMAINS || v === UNKNOWN ? v : UNKNOWN;
}

/** The least confident of two verdicts: the one a claim has to be made from. */
export function worse(a, b) {
  const x = asVerdict(a);
  const y = asVerdict(b);
  return RANK[y] > RANK[x] ? y : x;
}
