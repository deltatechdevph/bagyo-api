// Node 18+ — look up the current wind signal for a location.
//   BAGYO_API_KEY=bgy_live_... node examples/lookup.mjs Bulacan
const API = process.env.BAGYO_API_URL ?? 'http://localhost:3000';
const KEY = process.env.BAGYO_API_KEY ?? 'bgy_live_demo0000000000000000000000000000';
const query = process.argv[2] ?? 'Batanes';

const res = await fetch(`${API}/v1/signals/lookup?q=${encodeURIComponent(query)}`, {
  headers: { authorization: `Bearer ${KEY}` },
});
if (!res.ok) {
  const { error } = await res.json();
  console.error(`${res.status} ${error.code}: ${error.message}`);
  process.exit(1);
}
const { data, source, disclaimer } = await res.json();
if (data.signal) {
  const { level, coverage, partialDescriptor, context } = data.signal;
  console.log(
    `Signal No. ${level} over ${data.query.matchedName ?? query}` +
      (partialDescriptor ? ` (${partialDescriptor})` : '') +
      ` — ${context.cyclone.pagasaName} bulletin #${context.bulletin.bulletinNumber} [${coverage}]`,
  );
} else {
  console.log(`No wind signal currently in effect for ${data.query.matchedName ?? query}.`);
}
console.log(`\nSource: ${source}\n${disclaimer}`);
