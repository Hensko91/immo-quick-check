/*
 * Immo-Quick-Check – Datenlogik
 *
 * Reine Funktionen ohne DOM und ohne Netzwerk:
 *  - Datenbestand (Objekte, Marktdaten, Löschvermerke) normalisieren
 *  - zwei Datenbestände zusammenführen (gemeinsame Objektliste über GitHub)
 *  - passende Marktdaten zu einer Lage finden
 *  - Ergebniszeile einer Claude-Recherche auslesen
 *  - Marktdaten als Markdown für 06_Marktdaten_Region.md ausgeben
 *
 * Läuft im Browser (window.Daten, benötigt window.Calc) und in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc.js'));
  else root.Daten = factory(root.Calc);
})(typeof self !== 'undefined' ? self : this, function (Calc) {
  'use strict';

  const VERSION = 1;

  /** Leerer Datenbestand. */
  const leererBestand = () => ({ version: VERSION, objekte: [], marktdaten: [], geloescht: [] });

  /**
   * Akzeptiert das alte Format (reine Objektliste als Array) und das neue
   * ({ objekte, marktdaten, geloescht }); verwirft ungültige Einträge.
   */
  function normalisiereBestand(x) {
    const b = leererBestand();
    if (Array.isArray(x)) x = { objekte: x };
    if (!x || typeof x !== 'object') return b;
    const istObj = (o) => o && typeof o === 'object' && typeof o.id === 'string' && o.id;
    b.objekte = (Array.isArray(x.objekte) ? x.objekte : []).filter((o) => istObj(o) && o.felder && typeof o.felder === 'object');
    b.marktdaten = (Array.isArray(x.marktdaten) ? x.marktdaten : []).filter((m) => istObj(m) && typeof m.ort === 'string');
    b.geloescht = (Array.isArray(x.geloescht) ? x.geloescht : []).filter((g) => istObj(g) && typeof g.zeit === 'string');
    return b;
  }

  const zeitObjekt = (o) => String(o.gespeichert || '');
  const zeitMarkt = (m) => String(m.geaendert || '');

  /**
   * Zwei Datenbestände zusammenführen:
   *  - gleiche ID: der zuletzt gespeicherte Stand gewinnt
   *  - Löschvermerk gewinnt, wenn er nicht älter ist als der Eintrag
   *  - alles andere wird vereinigt (nichts geht verloren)
   */
  function fuehreZusammen(a, b) {
    a = normalisiereBestand(a);
    b = normalisiereBestand(b);
    const tote = new Map();
    for (const g of a.geloescht.concat(b.geloescht)) {
      if (!tote.has(g.id) || tote.get(g.id).zeit < g.zeit) tote.set(g.id, g);
    }
    const vereinige = (la, lb, zeit) => {
      const m = new Map();
      for (const e of la.concat(lb)) {
        const alt = m.get(e.id);
        if (!alt || zeit(e) > zeit(alt)) m.set(e.id, e);
      }
      return [...m.values()].filter((e) => !(tote.has(e.id) && tote.get(e.id).zeit >= zeit(e)));
    };
    const objekte = vereinige(a.objekte, b.objekte, zeitObjekt).sort((x, y) => zeitObjekt(y).localeCompare(zeitObjekt(x)));
    const marktdaten = vereinige(a.marktdaten, b.marktdaten, zeitMarkt)
      .sort((x, y) => (x.ort || '').localeCompare(y.ort || '', 'de') || (x.stadtteil || '').localeCompare(y.stadtteil || '', 'de'));
    return { version: VERSION, objekte, marktdaten, geloescht: [...tote.values()] };
  }

  /** Gleicher Inhalt (Reihenfolge der Schlüssel egal)? Für „nichts zu speichern“. */
  function gleicherBestand(a, b) {
    const kanon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {}) : v));
    return kanon(fuehreZusammen(a, leererBestand())) === kanon(fuehreZusammen(b, leererBestand()));
  }

  // ---------------------------------------------------------------------------
  // Marktdaten
  // ---------------------------------------------------------------------------

  /** Für Vergleiche: Kleinschreibung, ohne Klammern, Satzzeichen und doppelte Leerzeichen. */
  function normText(s) {
    return String(s || '').toLowerCase().replace(/[(),;/]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Passenden Marktdaten-Eintrag zu einer Lage finden.
   * lage: { stadt, stadtteil, kreis, text, objektart, baujahr } – text ist die frei eingegebene Adresse.
   * feld (optional): nur Einträge, die diesen Wert haben (z. B. 'mieteQm').
   * Einträge mit objektart bzw. baujahrVon/baujahrBis gelten nur für passende Objekte.
   * Vorrang: gleicher Ort und gleicher Stadtteil, dann Eintrag für den ganzen Ort,
   * zuletzt Eintrag für den Landkreis. Einträge für einen anderen Stadtteil werden
   * nicht verwendet. Bei mehreren Treffern gewinnt der neueste Stand.
   */
  function findeMarktdaten(tabelle, lage, feld) {
    if (!Array.isArray(tabelle) || !lage) return null;
    const stadt = normText(lage.stadt);
    const teil = normText(lage.stadtteil);
    const text = normText(lage.text);
    const kreis = normText(lage.kreis);
    let bester = null;
    let besterRang = -1;
    for (const e of tabelle) {
      const ort = normText(e.ort);
      if (ort.length < 2) continue;
      if (feld && !(typeof e[feld] === 'number' && e[feld] > 0)) continue;
      if (e.objektart && lage.objektart && e.objektart !== lage.objektart) continue;
      if ((e.baujahrVon || e.baujahrBis) && !(typeof lage.baujahr === 'number')) continue;
      if (e.baujahrVon && lage.baujahr < e.baujahrVon) continue;
      if (e.baujahrBis && lage.baujahr > e.baujahrBis) continue;
      const ortPasst = (stadt && ort === stadt) || (text && (` ${text} `).includes(` ${ort} `));
      const kreisPasst = !ortPasst && kreis && ort === kreis;
      if (!ortPasst && !kreisPasst) continue;
      const eTeil = normText(e.stadtteil);
      let rang;
      if (kreisPasst) { if (eTeil) continue; rang = 0; }
      else if (!eTeil) rang = 1;
      else if ((teil && eTeil === teil) || (text && (` ${text} `).includes(` ${eTeil} `))) rang = 2;
      else continue;
      const neuer = bester && String(e.datum || '') > String(bester.datum || '');
      if (rang > besterRang || (rang === besterRang && neuer)) {
        bester = e;
        besterRang = rang;
      }
    }
    return bester;
  }

  /**
   * Ergebniszeile aus einer Claude-Recherche auslesen, z. B.:
   * MARKTDATEN; Ort=Halle (Saale); Stadtteil=Paulusviertel; Miete=7,80; Kaufpreis=2.150; Quelle=Mietspiegel Halle 2025; Stand=2026-10
   */
  function leseClaudeMarktdaten(text) {
    const zeile = String(text || '').split(/\r?\n/).map((z) => z.trim().replace(/^[`*>\s-]+|[`*\s]+$/g, ''))
      .find((z) => /^MARKTDATEN\b/i.test(z));
    if (!zeile) return { ok: false, fehler: 'Keine Zeile „MARKTDATEN; …“ gefunden. Bitte die letzte Zeile der Claude-Antwort einfügen.' };
    const werte = {};
    for (const teil of zeile.split(';').slice(1)) {
      const i = teil.indexOf('=');
      if (i < 0) continue;
      werte[teil.slice(0, i).trim().toLowerCase()] = teil.slice(i + 1).trim();
    }
    const zahlOderNull = (v) => {
      if (!v || /^(–|-|keine|unbekannt|n\/?a)$/i.test(v)) return null;
      const n = Calc.parseZahl(v.replace(/€.*$/, ''));
      return n !== null && n > 0 ? n : null;
    };
    const eintrag = {
      ort: werte.ort || '',
      stadtteil: werte.stadtteil && !/^(–|-|keine?r?)$/i.test(werte.stadtteil) ? werte.stadtteil : '',
      mieteQm: zahlOderNull(werte.miete),
      kaufpreisQm: zahlOderNull(werte.kaufpreis),
      quelle: werte.quelle || '',
      datum: werte.stand || '',
    };
    if (!eintrag.ort) return { ok: false, fehler: 'In der Zeile fehlt „Ort=…“.' };
    if (eintrag.mieteQm === null && eintrag.kaufpreisQm === null) return { ok: false, fehler: 'In der Zeile fehlen Miete und Kaufpreis.' };
    if (!eintrag.quelle) return { ok: false, fehler: 'In der Zeile fehlt „Quelle=…“. Marktdaten nur mit Quelle übernehmen.' };
    return { ok: true, eintrag };
  }

  // ---------------------------------------------------------------------------
  // Hinterlegte Referenzdaten (amtliche Quellen, nur lesend)
  // ---------------------------------------------------------------------------

  const QUELLE_LSA = 'Gutachterausschuss Sachsen-Anhalt, Grundstücksmarktinformationen 2025 (Weiterverkauf, Daten 2024)';
  /** Kaufpreise je m² Wohnfläche aus amtlichen Marktberichten. */
  const REFERENZ_MARKTDATEN = [
    { id: 'ref-halle-etw-altbau', ort: 'Halle (Saale)', stadtteil: '', objektart: 'ETW', baujahrBis: 1948, kaufpreisQm: 2050, quelle: QUELLE_LSA, datum: '2025', notiz: 'Eigentumswohnungen Altbau vor 1949', referenz: true },
    { id: 'ref-halle-mfh', ort: 'Halle (Saale)', stadtteil: '', objektart: 'MFH', kaufpreisQm: 1250, quelle: QUELLE_LSA, datum: '2025', notiz: 'Mehrfamilienhäuser, Mittelwert', referenz: true },
    { id: 'ref-saalekreis-mfh', ort: 'Saalekreis', stadtteil: '', objektart: 'MFH', kaufpreisQm: 670, quelle: QUELLE_LSA, datum: '2025', notiz: 'Mehrfamilienhäuser, Mittelwert', referenz: true },
  ];

  /**
   * Qualifizierter Mietspiegel Halle (Saale), Fortschreibung 2026 (gültig 2026/2027):
   * Basismiete nach Wohnfläche (Tab. 2) × (1 + Zuschläge Baujahr und Wohnlage, Tab. 3).
   * Weitere Ausstattungsmerkmale (Bad, Balkon, Küche, Modernisierung) sind nicht berücksichtigt.
   */
  const MIETSPIEGEL_HALLE = {
    quelle: 'Mietspiegel Stadt Halle (Saale), Fortschreibung 2026',
    stand: '2026',
    spanne: 0.14,
    // Basismieten €/m² für 20–21, 22–23, … , 146–147 und 148–150 m²
    basis: [7.86, 7.53, 7.24, 7.03, 6.83, 6.67, 6.55, 6.43, 6.34, 6.26, 6.19, 6.14, 6.14, 6.05, 6.02, 5.99, 5.97, 5.96, 5.95, 5.95,
      5.94, 5.94, 5.95, 5.95, 5.96, 5.97, 5.98, 6.00, 6.01, 6.03, 6.05, 6.08, 6.10, 6.12, 6.15, 6.17, 6.20, 6.22, 6.25, 6.28,
      6.32, 6.35, 6.38, 6.41, 6.44, 6.47, 6.50, 6.53, 6.58, 6.61, 6.64, 6.68, 6.71, 6.75, 6.79, 6.83, 6.86, 6.90, 6.94, 6.97,
      7.02, 7.06, 7.09, 7.13, 7.18],
    baujahr: [[1918, 0.05], [1948, 0.06], [1960, 0.10], [1972, 0], [1989, -0.07], [2002, 0.11], [2015, 0.25], [Infinity, 0.50]],
    wohnlage: { A: 0.15, B: 0.10, C: 0.05, D: 0 },
  };

  /** Stadt mit hinterlegtem Mietspiegel? */
  function hatMietspiegel(lage) {
    const t = ` ${normText(lage && lage.stadt)} ${normText(lage && lage.text)} `;
    return t.includes(' halle saale ') || (normText(lage && lage.stadt) === 'halle');
  }

  /**
   * Ortsübliche Vergleichsmiete laut Mietspiegel (nur Halle, nur je Wohnung bis 150 m²).
   * Ohne Wohnlage wird D (± 0 %) angenommen. Liefert null, wenn nicht anwendbar.
   */
  function mietspiegelMiete(lage, { wohnflaeche, baujahr, wohnlage } = {}) {
    if (!hatMietspiegel(lage)) return null;
    if (typeof wohnflaeche !== 'number' || typeof baujahr !== 'number') return null;
    const m = MIETSPIEGEL_HALLE;
    const wf = Math.floor(wohnflaeche);
    if (wf < 20 || wf > 150) return null;
    const basis = m.basis[Math.min(m.basis.length - 1, Math.floor((wf - 20) / 2))];
    const zBaujahr = m.baujahr.find(([bis]) => baujahr <= bis)[1];
    const lageAngegeben = Object.prototype.hasOwnProperty.call(m.wohnlage, wohnlage);
    const zLage = lageAngegeben ? m.wohnlage[wohnlage] : 0;
    const miete = basis * (1 + zBaujahr + zLage);
    return {
      mieteQm: Math.round(miete * 100) / 100,
      basis, zBaujahr, zLage,
      wohnlage: lageAngegeben ? wohnlage : 'D',
      wohnlageAnnahme: !lageAngegeben,
      von: Math.round(miete * (1 - m.spanne) * 100) / 100,
      bis: Math.round(miete * (1 + m.spanne) * 100) / 100,
      quelle: m.quelle,
      stand: m.stand,
    };
  }

  /** Marktdaten-Tabelle als Markdown (Wissensdatei 06_Marktdaten_Region.md). */
  function marktdatenMarkdown(tabelle, stand) {
    const zelle = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
    const zahl = (v, s) => (typeof v === 'number' ? Calc.fmtZahl(v, s) : '–');
    const zeilen = (tabelle || []).map((m) =>
      `| ${zelle(m.ort)} | ${zelle(m.stadtteil || '–')} | ${zahl(m.mieteQm, 2)} | ${zahl(m.kaufpreisQm, 0)} | ${zelle(m.quelle)} | ${zelle(m.datum)} | ${zelle(m.notiz || '')} |`);
    return [
      '# 06 Marktdaten Region',
      '',
      `Stand des Exports: ${stand}. Selbst recherchierte Vergleichswerte aus dem Immo-Quick-Check.`,
      'Angebotsmieten und -preise aus Portalen sind keine Abschlusswerte; Quelle und Datum immer mit angeben.',
      '',
      '| Ort | Stadtteil | Marktmiete €/m² | Kaufpreis €/m² | Quelle | Stand | Notiz |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...zeilen,
      '',
    ].join('\n');
  }

  return {
    VERSION,
    leererBestand,
    normalisiereBestand,
    fuehreZusammen,
    gleicherBestand,
    normText,
    findeMarktdaten,
    leseClaudeMarktdaten,
    marktdatenMarkdown,
    REFERENZ_MARKTDATEN,
    MIETSPIEGEL_HALLE,
    hatMietspiegel,
    mietspiegelMiete,
  };
});
