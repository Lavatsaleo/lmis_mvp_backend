// Match a DHIS2 site (org unit name + county) to a site of the GPS list, by
// name. The two lists spell names differently ("Aulic OTP" / "Aluic OTP",
// "Mabior Wundiing" / "Mabior Wunding"), so matching goes from strict to loose:
//   1. same name (case, spaces and punctuation ignored)
//   2. same name without the site type (OTP, PHCC, PHCU, SC...), preferring the
//      same county and the same type
//   3. names one or two letters apart (typos, swapped letters), same county first

const TYPES = /\b(otp|phcc|phcu|sc|tsfp|bsfp|opd|site|outreach|hospital|hosp|centre|center|nutrition|clinic|county|health|unit)\b/g;

const full = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const base = (s) => full(s).replace(TYPES, " ").replace(/\s+/g, "");
const typeOf = (s) => (full(s).match(TYPES) || []).join(" ");
const countyKey = (s) => String(s || "").toLowerCase().replace(/county/g, "").replace(/gograil/g, "gogrial").replace(/[^a-z]/g, "");

/** Edit distance where swapping two neighbouring letters counts as one edit. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Build a matcher over the GPS list; returns (name, county) -> site | null. */
function siteMatcher(sites) {
  const items = sites.map((s) => ({ site: s, full: full(s.name).replace(/\s+/g, ""), base: base(s.name), type: typeOf(s.name), county: countyKey(s.county) }));
  const pick = (list, county, type) =>
    list.sort((x, y) => (y.county === county) - (x.county === county) || (y.type === type) - (x.type === type))[0]?.site || null;
  return (name, county) => {
    const f = full(name).replace(/\s+/g, "");
    const b = base(name);
    const t = typeOf(name);
    const c = countyKey(county);
    const exact = items.filter((i) => i.full === f);
    if (exact.length) return pick(exact, c, t);
    if (b) {
      const same = items.filter((i) => i.base === b);
      if (same.length) return pick(same, c, t);
      const allowed = b.length >= 9 ? 2 : b.length >= 4 ? 1 : 0;
      const close = items
        .map((i) => ({ ...i, d: i.base ? distance(i.base, b) : 99 }))
        .filter((i) => i.d <= allowed)
        .sort((x, y) => x.d - y.d || (y.county === c) - (x.county === c));
      if (close.length) return close[0].site;
    }
    return null;
  };
}

module.exports = { siteMatcher, countyKey, distance };
