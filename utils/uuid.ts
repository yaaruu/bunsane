// RFC 9562 UUIDv7: 48-bit unix-ms timestamp | ver 7 | 12-bit monotonic
// sub-millisecond sequence (rand_a) | variant | 62 random bits (rand_b).
//
// The previous implementation used Math.random() with no sequence — two ids
// generated in the same millisecond could collide and were not monotonic
// (breaks index locality and the "sortable id" assumption at high insert
// rates). This one keeps strict per-process monotonicity: same-ms calls bump
// the 12-bit sequence; on overflow we borrow the next millisecond.

let lastTs = -1;
let seq = 0;

const HEX: string[] = new Array(256);
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

// Reused buffer — uuidv7 is called once per entity + once per component on
// every insert; per-call allocation matters. Single-threaded JS makes the
// shared buffer safe.
const rnd = new Uint8Array(8);

export const uuidv7 = (): string => {
  let ts = Date.now();
  if (ts <= lastTs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastTs++;
    ts = lastTs;
  } else {
    lastTs = ts;
    seq = 0;
  }

  const tsHex = ts.toString(16).padStart(12, '0');
  crypto.getRandomValues(rnd);
  rnd[0] = (rnd[0]! & 0x3f) | 0x80; // variant bits 10xx

  let randHex = '';
  for (let i = 0; i < 8; i++) randHex += HEX[rnd[i]!];

  return `${tsHex.slice(0, 8)}-${tsHex.slice(8)}-7${seq.toString(16).padStart(3, '0')}-${randHex.slice(0, 4)}-${randHex.slice(4)}`;
};
