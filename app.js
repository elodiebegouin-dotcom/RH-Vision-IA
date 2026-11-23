/* =====================================================================
   Tri CV CHIFFON — application 100 % navigateur (aucun serveur).
   Aucun CV n'est envoyé sur Internet : lecture, masquage et notation
   sont faits localement. Seules les grilles de postes sont mémorisées
   dans le navigateur (localStorage). Les CV et le registre restent en
   mémoire et disparaissent à la fermeture de la page.
   ===================================================================== */
(() => {
  "use strict";

  const LS_GRILLES = "tricv.chiffon.grilles.v1";
  const CONSERVATION_JOURS = 365;
  const ALERTE_JOURS = 30;

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }

  /* ---------------- État ---------------- */
  const etat = {
    grilles: chargerGrilles(),
    grilleId: null,
    candidats: [],     // {ref, nom, texte, decision, consentement, dernierContact, note}
    registre: [],      // lignes du registre vivier
    journal: [],       // purges : {ref, dateSuppression, motif}
    ouvert: null,
    compteur: 0
  };
  etat.grilleId = etat.grilles[0].id;

  /* ---------------- Utilitaires ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[’`]/g, "'");
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aujourdhui = () => new Date().toISOString().slice(0, 10);
  const ajouterJours = (iso, j) => {
    const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + j);
    return d.toISOString().slice(0, 10);
  };
  const joursAvant = iso => Math.round((new Date(iso + "T12:00:00") - new Date(aujourdhui() + "T12:00:00")) / 864e5);
  const fmtDate = iso => iso ? iso.split("-").reverse().join("/") : "";
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function chargerGrilles() {
    try {
      const g = JSON.parse(localStorage.getItem(LS_GRILLES));
      if (Array.isArray(g) && g.length) return g;
    } catch (e) { /* stockage indisponible */ }
    return clone(GRILLES_DEFAUT);
  }
  function sauverGrilles() {
    try { localStorage.setItem(LS_GRILLES, JSON.stringify(etat.grilles)); } catch (e) { /* ignore */ }
  }
  const grille = () => etat.grilles.find(g => g.id === etat.grilleId) || etat.grilles[0];

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2600);
  }

  function telecharger(nom, contenu, type) {
    const blob = new Blob([contenu], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nom;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- Masquage des données à risque de biais ---------------- */
  // Bornes de mot compatibles avec les lettres accentuées (\b ne les gère pas).
  const D = "(?<![\\wÀ-ÿ])", F = "(?![\\wÀ-ÿ])";
  const R = (s, f = "gi") => new RegExp(s, f);
  const MASQUES = [
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[e-mail]"],
    [/(\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g, "[téléphone]"],
    [/(https?:\/\/)?(www\.)?linkedin\.com\/\S+/gi, "[profil en ligne]"],
    [/\b\d{1,2}[\/.-]\d{1,2}[\/.-](19|20)\d{2}\b/g, "[date]"],
    [R(D + "(date de naissance|n[ée]e?(\\s*\\(e\\))?\\s+le)" + F + "\\s*:?[^\\n.;,]{0,25}"), "[naissance]"],
    [R(D + "(âg[ée]e?s?|age)\\s*(de|:)?\\s*\\d{2}\\s*ans"), "[âge]"],
    [/\b(19|20)\d{2}\b/g, "[année]"],
    [R(D + "(mari[ée]e?|c[ée]libataire|pacs[ée]e?|divorc[ée]e?|veuf|veuve)" + F), "[situation familiale]"],
    [R(D + "\\d+\\s+enfants?" + F), "[situation familiale]"],
    [R(D + "nationalit[ée]\\s*:?\\s*[^\\n,;.]+"), "[nationalité]"],
    [R(D + "(madame|monsieur|mme|mlle)" + F + "\\.?"), "[civilité]"],
    [R(D + "\\d{1,4}\\s*,?\\s*(bis\\s+)?(rue|avenue|av\\.|boulevard|bd|chemin|all[ée]e|impasse|place|route)" + F + "[^\\n,]*"), "[adresse]"],
    [/\b\d{5}\s+[A-ZÉÈ][\w-]+/g, "[ville]"]
  ];
  function masquer(texte) {
    let n = 0, t = texte;
    for (const [re, rep] of MASQUES) t = t.replace(re, () => { n++; return rep; });
    return { texte: t, nb: n };
  }

  /* Expérience déclarée (heuristique) : « 8 ans », « plus de 12 ans », « 18 mois » */
  function experience(texte) {
    const t = norm(texte);
    let max = null;
    for (const m of t.matchAll(/(?:^|[^\d])(\d{1,2})\s*(?:ans|annees)\b/g)) {
      const avant = t.slice(Math.max(0, m.index - 12), m.index);
      if (/age/.test(avant)) continue;
      const v = +m[1]; if (v <= 45) max = Math.max(max ?? 0, v);
    }
    for (const m of t.matchAll(/(\d{1,3})\s*mois\b/g)) {
      const v = Math.round(+m[1] / 12 * 10) / 10; max = Math.max(max ?? 0, v);
    }
    return max;
  }

  /* ---------------- Notation ---------------- */
  function trouve(tNorm, motCle) {
    const k = norm(motCle).trim(); if (!k) return false;
    return new RegExp("(^|[^a-z0-9])" + reEsc(k)).test(tNorm);
  }

  function analyser(c, g) {
    const m = masquer(c.texte);
    const t = norm(m.texte);
    const exp = experience(c.texte);
    let total = 0, poidsTotal = 0;
    const details = g.criteres.map(cr => {
      const hits = [...new Set(cr.motsCles.filter(k => trouve(t, k)))];
      const s = Math.min(1, hits.length / 2);
      total += cr.poids * s; poidsTotal += +cr.poids;
      return { ...cr, hits, s };
    });
    let sExp = 0;
    if (g.poidsExp > 0) {
      sExp = exp == null ? 0 : Math.min(1, exp / Math.max(1, g.minExp));
      total += g.poidsExp * sExp; poidsTotal += +g.poidsExp;
    }
    const score = poidsTotal ? Math.round(total / poidsTotal * 100) : 0;

    const signaux = [];
    details.filter(d => d.indispensable && !d.hits.length)
      .forEach(d => signaux.push({ grave: true, message: `Critère indispensable non détecté : « ${d.nom} ».` }));
    if (exp == null) signaux.push({ message: "Expérience non chiffrée dans le CV : à vérifier en entretien." });
    else if (exp < g.minExp) signaux.push({ message: `Expérience détectée (${exp} an${exp >= 2 ? "s" : ""}) inférieure au minimum souhaité (${g.minExp} ans).` });
    (g.signaux || []).forEach(sg => {
      const motifs = sg.motif.split("|").map(s => s.trim()).filter(Boolean);
      if (motifs.some(k => trouve(t, k))) signaux.push({ message: sg.message });
    });

    const indispensableManquant = signaux.some(s => s.grave);
    const niveau = indispensableManquant ? "manque" : score >= 70 ? "fort" : score >= 45 ? "moyen" : "faible";
    return { score, details, exp, sExp, signaux, niveau, masque: m };
  }

  const NIVEAUX = {
    fort: ["Forte adéquation", "b-fort"],
    moyen: ["À étudier", "b-moyen"],
    faible: ["Faible adéquation", "b-faible"],
    manque: ["Indispensable absent", "b-manque"]
  };

  function questions(a, g) {
    const q = [];
    a.details.slice().sort((x, y) => x.s - y.s).slice(0, 3).forEach(d => {
      q.push(d.s < 1
        ? `« ${d.nom} » : décrivez une situation concrète où vous avez agi sur ce sujet. Quel était le contexte, votre rôle, le résultat ?`
        : `« ${d.nom} » : quel est le projet dont vous êtes le plus fier(e) sur ce sujet, et que referiez-vous différemment ?`);
    });
    a.signaux.filter(s => !s.grave).slice(0, 3).forEach(s => q.push(`Point à clarifier — ${s.message}`));
    q.push(`Projet de CHIFFON (fabrication française, tissus recyclés, vocation sociale) : qu'est-ce qui vous motive à le rejoindre sur le poste « ${g.poste} » ?`);
    return q;
  }

  /* ---------------- Onglets ---------------- */
  $$(".onglets button").forEach(b => b.addEventListener("click", () => {
    $$(".onglets button").forEach(x => x.classList.toggle("actif", x === b));
    $$(".panneau").forEach(p => p.hidden = p.id !== b.dataset.cible);
    rendreTout();
  }));

  /* ---------------- Onglet 1 : poste & grille ---------------- */
  function rendreGrille() {
    const g = grille();
    $("#selPoste").innerHTML = etat.grilles.map(x =>
      `<option value="${esc(x.id)}" ${x.id === g.id ? "selected" : ""}>${esc(x.poste)}</option>`).join("");
    $("#gPoste").value = g.poste;
    $("#gContexte").value = g.contexte || "";
    $("#gMinExp").value = g.minExp;
    $("#gPoidsExp").value = g.poidsExp;

    $("#tCriteres tbody").innerHTML = g.criteres.map((c, i) => `
      <tr data-i="${i}">
        <td><input data-f="nom" value="${esc(c.nom)}" aria-label="Nom du critère"></td>
        <td><input data-f="poids" type="number" min="0" max="100" value="${c.poids}" class="num" aria-label="Poids"></td>
        <td><textarea data-f="motsCles" rows="2" aria-label="Mots-clés">${esc(c.motsCles.join(", "))}</textarea></td>
        <td class="c"><input data-f="indispensable" type="checkbox" ${c.indispensable ? "checked" : ""} aria-label="Indispensable"></td>
        <td class="c"><button class="lien danger" data-suppr="${i}" title="Supprimer ce critère">✕</button></td>
      </tr>`).join("");
    $("#tSignaux tbody").innerHTML = (g.signaux || []).map((s, i) => `
      <tr data-i="${i}">
        <td><input data-f="motif" value="${esc(s.motif)}" aria-label="Motif"></td>
        <td><input data-f="message" value="${esc(s.message)}" aria-label="Message"></td>
        <td class="c"><button class="lien danger" data-suppr-sig="${i}" title="Supprimer ce signal">✕</button></td>
      </tr>`).join("");
    const somme = g.criteres.reduce((s, c) => s + (+c.poids || 0), 0) + (+g.poidsExp || 0);
    $("#sommePoids").textContent = `Total des poids : ${somme} (les scores sont ramenés sur 100 quel que soit le total).`;
  }

  $("#selPoste").addEventListener("change", e => { etat.grilleId = e.target.value; etat.ouvert = null; rendreGrille(); });
  ["gPoste", "gContexte", "gMinExp", "gPoidsExp"].forEach(id => $("#" + id).addEventListener("input", e => {
    const g = grille();
    const champ = { gPoste: "poste", gContexte: "contexte", gMinExp: "minExp", gPoidsExp: "poidsExp" }[id];
    g[champ] = e.target.type === "number" ? Math.max(0, +e.target.value || 0) : e.target.value;
    sauverGrilles();
    if (id === "gPoste") $("#selPoste").selectedOptions[0].textContent = g.poste;
  }));
  $("#tCriteres").addEventListener("input", e => {
    const tr = e.target.closest("tr[data-i]"); if (!tr) return;
    const c = grille().criteres[+tr.dataset.i], f = e.target.dataset.f;
    if (f === "poids") c.poids = Math.max(0, +e.target.value || 0);
    else if (f === "motsCles") c.motsCles = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
    else if (f === "indispensable") c.indispensable = e.target.checked;
    else c[f] = e.target.value;
    sauverGrilles();
    const g = grille();
    $("#sommePoids").textContent = `Total des poids : ${g.criteres.reduce((s, c) => s + (+c.poids || 0), 0) + (+g.poidsExp || 0)} (les scores sont ramenés sur 100 quel que soit le total).`;
  });
  $("#tCriteres").addEventListener("change", e => { if (e.target.type === "checkbox") $("#tCriteres").dispatchEvent(new Event("input")); });
  $("#tCriteres").addEventListener("click", e => {
    const i = e.target.dataset.suppr; if (i == null) return;
    grille().criteres.splice(+i, 1); sauverGrilles(); rendreGrille();
  });
  $("#tSignaux").addEventListener("input", e => {
    const tr = e.target.closest("tr[data-i]"); if (!tr) return;
    grille().signaux[+tr.dataset.i][e.target.dataset.f] = e.target.value; sauverGrilles();
  });
  $("#tSignaux").addEventListener("click", e => {
    const i = e.target.dataset.supprSig; if (i == null) return;
    grille().signaux.splice(+i, 1); sauverGrilles(); rendreGrille();
  });
  $("#btnAjoutCritere").addEventListener("click", () => {
    grille().criteres.push({ nom: "Nouveau critère", poids: 10, indispensable: false, motsCles: [] });
    sauverGrilles(); rendreGrille();
  });
  $("#btnAjoutSignal").addEventListener("click", () => {
    (grille().signaux ||= []).push({ motif: "mot-clé|autre mot", message: "Point à vérifier en entretien." });
    sauverGrilles(); rendreGrille();
  });
  $("#btnNouveauPoste").addEventListener("click", () => {
    const id = "poste-" + Date.now();
    etat.grilles.push({ id, poste: "Nouveau poste", contexte: "", minExp: 2, poidsExp: 10,
      criteres: [{ nom: "Compétence principale", poids: 40, indispensable: true, motsCles: [] }],
      signaux: clone(SIGNAUX_DEFAUT) });
    etat.grilleId = id; sauverGrilles(); rendreGrille(); $("#gPoste").select();
  });
  $("#btnDupliquer").addEventListener("click", () => {
    const n = clone(grille()); n.id = "poste-" + Date.now(); n.poste += " (copie)";
    etat.grilles.push(n); etat.grilleId = n.id; sauverGrilles(); rendreGrille();
  });
  $("#btnSupprPoste").addEventListener("click", () => {
    if (etat.grilles.length < 2) return toast("Il faut garder au moins un poste.");
    if (!confirm(`Supprimer la grille « ${grille().poste} » ?`)) return;
    etat.grilles = etat.grilles.filter(g => g.id !== etat.grilleId);
    etat.grilleId = etat.grilles[0].id; sauverGrilles(); rendreGrille();
  });
  $("#btnReinit").addEventListener("click", () => {
    if (!confirm("Remettre les 5 grilles CHIFFON d'origine ? Vos modifications seront perdues.")) return;
    etat.grilles = clone(GRILLES_DEFAUT); etat.grilleId = etat.grilles[0].id; sauverGrilles(); rendreGrille();
  });
  $("#btnExportGrilles").addEventListener("click", () =>
    telecharger("grilles-postes-chiffon.json", JSON.stringify(etat.grilles, null, 2), "application/json"));
  $("#fImportGrilles").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const g = JSON.parse(await f.text());
      if (!Array.isArray(g) || !g.every(x => x.id && x.poste && Array.isArray(x.criteres))) throw 0;
      etat.grilles = g; etat.grilleId = g[0].id; sauverGrilles(); rendreGrille(); toast("Grilles importées.");
    } catch { toast("Fichier de grilles invalide."); }
    e.target.value = "";
  });

  /* ---------------- Onglet 2 : candidatures ---------------- */
  function nouvelleRef() {
    etat.compteur++;
    return `CAND-${aujourdhui().replace(/-/g, "")}-${String(etat.compteur).padStart(3, "0")}`;
  }
  function ajouterCandidat(nom, texte) {
    texte = (texte || "").trim();
    if (texte.length < 40) { toast(`« ${nom} » : texte trop court ou illisible (PDF scanné ?).`); return; }
    etat.candidats.push({ ref: nouvelleRef(), nom, texte, decision: "a-trier", consentement: false,
      dernierContact: aujourdhui(), note: "" });
  }

  async function lireFichier(f) {
    const ext = f.name.split(".").pop().toLowerCase();
    if (ext === "txt" || ext === "md") return f.text();
    if (ext === "docx") {
      const r = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
      return r.value;
    }
    if (ext === "pdf") {
      const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
      let t = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const c = await page.getTextContent();
        t += c.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n";
      }
      return t;
    }
    throw new Error("Format non pris en charge (PDF, DOCX ou TXT).");
  }
  async function importerFichiers(files) {
    let ok = 0;
    for (const f of files) {
      try { const avant = etat.candidats.length; ajouterCandidat(f.name.replace(/\.[^.]+$/, ""), await lireFichier(f)); ok += etat.candidats.length - avant; }
      catch (err) { toast(`${f.name} : ${err.message || "lecture impossible"}`); }
    }
    if (ok) toast(`${ok} CV importé(s).`);
    rendreCandidats();
  }
  $("#fCV").addEventListener("change", e => { importerFichiers([...e.target.files]); e.target.value = ""; });
  const zone = $("#zoneDepot");
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("survol"); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("survol"); }));
  zone.addEventListener("drop", e => importerFichiers([...e.dataTransfer.files]));
  zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#fCV").click(); } });

  $("#btnColler").addEventListener("click", () => {
    const nom = $("#collerNom").value.trim() || `CV collé ${etat.candidats.length + 1}`;
    const avant = etat.candidats.length;
    ajouterCandidat(nom, $("#collerTexte").value);
    if (etat.candidats.length > avant) { $("#collerNom").value = ""; $("#collerTexte").value = ""; toast("CV ajouté."); }
    rendreCandidats();
  });
  $("#btnDemo").addEventListener("click", () => {
    CANDIDATURES_DEMO.forEach(([n, t]) => { if (!etat.candidats.some(c => c.nom === n)) ajouterCandidat(n, t); });
    toast("15 candidatures de l'Annexe 2 chargées."); rendreCandidats();
  });
  $("#btnViderCV").addEventListener("click", () => {
    if (!etat.candidats.length || !confirm("Retirer toutes les candidatures de la page ?")) return;
    etat.candidats = []; etat.ouvert = null; rendreCandidats();
  });
  $("#listeCV").addEventListener("click", e => {
    const r = e.target.dataset.retirer; if (!r) return;
    etat.candidats = etat.candidats.filter(c => c.ref !== r); rendreCandidats();
  });

  function rendreCandidats() {
    $("#nbCV").textContent = etat.candidats.length;
    $("#listeCV").innerHTML = etat.candidats.length ? etat.candidats.map(c => `
      <li><span><strong>${esc(c.nom)}</strong> <small>${esc(c.ref)} · ${c.texte.length.toLocaleString("fr-FR")} caractères</small></span>
      <button class="lien danger" data-retirer="${esc(c.ref)}">Retirer</button></li>`).join("")
      : `<li class="vide">Aucune candidature pour l'instant.</li>`;
  }

  /* ---------------- Onglet 3 : classement ---------------- */
  const DECISIONS = {
    "a-trier": "À trier", "rencontrer": "À rencontrer", "vivier": "Vivier (1 an)",
    "non-retenu": "Non retenu", "embauche": "Embauché(e)"
  };

  function rendreClassement() {
    const g = grille();
    $("#posteCourant").textContent = g.poste;
    $("#contexteCourant").textContent = g.contexte || "";
    if (!etat.candidats.length) {
      $("#tClassement tbody").innerHTML = `<tr><td colspan="6" class="vide">Ajoutez des candidatures dans l'onglet 2 (ou chargez la démo).</td></tr>`;
      return;
    }
    const lignes = etat.candidats.map(c => ({ c, a: analyser(c, g) }))
      .sort((x, y) => (x.a.niveau === "manque") - (y.a.niveau === "manque") || y.a.score - x.a.score);
    $("#tClassement tbody").innerHTML = lignes.map(({ c, a }, i) => {
      const [lib, cls] = NIVEAUX[a.niveau];
      const ouvert = etat.ouvert === c.ref;
      return `
      <tr class="ligne ${ouvert ? "ouvert" : ""}" data-ref="${esc(c.ref)}" tabindex="0" aria-expanded="${ouvert}">
        <td class="c">${i + 1}</td>
        <td><strong>${esc(c.nom)}</strong><br><small>${esc(c.ref)}</small></td>
        <td><div class="jauge"><span style="width:${a.score}%"></span></div><b>${a.score}</b>/100</td>
        <td><span class="badge ${cls}">${lib}</span></td>
        <td class="c">${a.signaux.length ? `<span class="pastille">${a.signaux.length}</span>` : "–"}</td>
        <td><span class="badge b-dec">${DECISIONS[c.decision]}</span></td>
      </tr>
      ${ouvert ? `<tr class="detail"><td colspan="6">${detailHTML(c, a, g)}</td></tr>` : ""}`;
    }).join("");
  }

  function detailHTML(c, a, g) {
    const crit = a.details.map(d => `
      <div class="crit">
        <div class="crit-tete"><span>${esc(d.nom)}${d.indispensable ? ' <em class="ind">indispensable</em>' : ""}</span>
        <span>${Math.round(d.s * 100)} % · poids ${d.poids}</span></div>
        <div class="jauge fine"><span style="width:${d.s * 100}%"></span></div>
        <small>${d.hits.length ? "Trouvé : " + d.hits.map(h => `<mark>${esc(h)}</mark>`).join(" ") : "Aucun mot-clé trouvé"}</small>
      </div>`).join("");
    const exp = `<div class="crit"><div class="crit-tete"><span>Expérience déclarée (minimum souhaité : ${g.minExp} ans)</span>
      <span>${a.exp == null ? "non chiffrée" : a.exp + " an" + (a.exp >= 2 ? "s" : "")} · poids ${g.poidsExp}</span></div>
      <div class="jauge fine"><span style="width:${a.sExp * 100}%"></span></div></div>`;
    const sig = a.signaux.length
      ? `<ul class="signaux">${a.signaux.map(s => `<li class="${s.grave ? "grave" : ""}">${esc(s.message)}</li>`).join("")}</ul>`
      : `<p class="muet">Aucun point d'attention détecté.</p>`;
    const qs = `<ol class="questions">${questions(a, g).map(q => `<li>${esc(q)}</li>`).join("")}</ol>`;
    return `
    <div class="detail-grille">
      <section><h4>Détail du score</h4>${crit}${exp}</section>
      <section>
        <h4>Points d'attention</h4>${sig}
        <h4>Questions d'entretien suggérées</h4>${qs}
      </section>
      <section class="decision">
        <h4>Décision du recruteur</h4>
        <label>Décision
          <select data-champ="decision" data-ref="${esc(c.ref)}">
            ${Object.entries(DECISIONS).map(([k, v]) => `<option value="${k}" ${c.decision === k ? "selected" : ""}>${v}</option>`).join("")}
          </select></label>
        <label class="ligne-case"><input type="checkbox" data-champ="consentement" data-ref="${esc(c.ref)}" ${c.consentement ? "checked" : ""}>
          Le candidat a accepté la conservation de son CV pendant 1 an</label>
        <label>Date du dernier contact
          <input type="date" data-champ="dernierContact" data-ref="${esc(c.ref)}" value="${c.dernierContact}"></label>
        <label>Notes (factuelles, liées au poste)
          <textarea data-champ="note" data-ref="${esc(c.ref)}" rows="3">${esc(c.note)}</textarea></label>
        ${c.decision === "vivier" && !c.consentement ? `<p class="alerte">Vivier sans consentement : le CV ne pourra pas être conservé. Demandez l'accord du candidat.</p>` : ""}
        <details><summary>Voir le texte analysé (${a.masque.nb} élément(s) masqué(s))</summary>
          <pre class="texte">${esc(a.masque.texte)}</pre></details>
      </section>
    </div>`;
  }

  $("#tClassement").addEventListener("click", e => {
    const tr = e.target.closest("tr.ligne"); if (!tr) return;
    etat.ouvert = etat.ouvert === tr.dataset.ref ? null : tr.dataset.ref; rendreClassement();
  });
  $("#tClassement").addEventListener("keydown", e => {
    const tr = e.target.closest("tr.ligne"); if (!tr || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault(); tr.click();
  });
  const majChamp = e => {
    const champ = e.target.dataset.champ, ref = e.target.dataset.ref; if (!champ) return;
    const c = etat.candidats.find(x => x.ref === ref); if (!c) return;
    c[champ] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if (champ === "decision" && e.target.value === "vivier" && !c.consentement) rendreClassement();
    if (champ === "decision" || champ === "consentement") rendreClassement();
  };
  $("#tClassement").addEventListener("change", majChamp);
  $("#tClassement").addEventListener("input", e => { if (e.target.dataset.champ === "note") majChamp(e); });

  $("#btnExportClassement").addEventListener("click", () => {
    if (!etat.candidats.length) return toast("Aucune candidature à exporter.");
    const g = grille();
    const rows = etat.candidats.map(c => ({ c, a: analyser(c, g) })).sort((x, y) => y.a.score - x.a.score)
      .map(({ c, a }, i) => [i + 1, c.ref, c.nom, g.poste, a.score, NIVEAUX[a.niveau][0],
        ...a.details.map(d => Math.round(d.s * 100)), a.exp ?? "", a.signaux.map(s => s.message).join(" | "),
        DECISIONS[c.decision], c.note]);
    const tete = ["Rang", "Référence", "Candidat", "Poste", "Score /100", "Adéquation",
      ...g.criteres.map(c => c.nom + " (%)"), "Expérience (ans)", "Points d'attention", "Décision", "Notes"];
    telecharger(`classement-${g.id}-${aujourdhui()}.csv`, csv([tete, ...rows]), "text/csv;charset=utf-8");
  });

  $("#btnVersRegistre").addEventListener("click", () => {
    const g = grille(); let n = 0;
    etat.candidats.filter(c => c.decision !== "a-trier").forEach(c => {
      const a = analyser(c, g);
      const ligne = ligneRegistre({ ref: c.ref, emplacement: c.nom, poste: g.poste, score: a.score,
        decision: DECISIONS[c.decision], consentement: c.consentement ? "Oui" : "Non",
        dernierContact: c.dernierContact, notes: c.note });
      const i = etat.registre.findIndex(r => r.ref === c.ref);
      if (i >= 0) etat.registre[i] = ligne; else etat.registre.push(ligne);
      n++;
    });
    toast(n ? `${n} décision(s) reportée(s) dans le registre. Pensez à l'exporter.` : "Aucune décision prise (toutes « À trier »).");
    rendreRegistre();
  });

  /* ---------------- Onglet 4 : registre vivier & conservation ---------------- */
  /* Règle : avec consentement → expiration = dernier contact + 365 j.
     Sans consentement → suppression à la clôture du recrutement.
     Embauché(e) → sort du vivier, bascule dans le dossier du personnel. */
  function ligneRegistre(r) {
    const embauche = /embauch/i.test(r.decision);
    const consent = /^oui$/i.test(String(r.consentement).trim());
    let expiration = "", statut;
    if (embauche) statut = "Sortir du vivier → dossier du personnel";
    else if (!consent) statut = "Sans consentement : supprimer à la clôture du recrutement";
    else {
      expiration = ajouterJours(r.dernierContact || aujourdhui(), CONSERVATION_JOURS);
      const j = joursAvant(expiration);
      statut = j < 0 ? "EXPIRÉ : supprimer le CV" : j <= ALERTE_JOURS ? `Expire dans ${j} j : relancer le candidat` : "Actif";
    }
    return { ...r, consentement: consent ? "Oui" : "Non", expiration, statut };
  }
  const ENTETES_REG = ["Référence", "Emplacement du CV", "Poste", "Score", "Décision", "Consentement vivier",
    "Date dernier contact", "Date d'expiration", "Statut", "Notes"];
  const CLES_REG = ["ref", "emplacement", "poste", "score", "decision", "consentement", "dernierContact", "expiration", "statut", "notes"];

  function classeStatut(s) {
    return s.startsWith("EXPIRÉ") ? "st-expire" : s.startsWith("Expire") ? "st-bientot"
      : s.startsWith("Sans") ? "st-sans" : s.startsWith("Sortir") ? "st-sortie" : "st-actif";
  }
  function rendreRegistre() {
    etat.registre = etat.registre.map(ligneRegistre);
    const nb = k => etat.registre.filter(r => classeStatut(r.statut) === k).length;
    $("#kActifs").textContent = nb("st-actif");
    $("#kBientot").textContent = nb("st-bientot");
    $("#kExpires").textContent = nb("st-expire") + nb("st-sans");
    $("#kJournal").textContent = etat.journal.length;
    const tri = { "st-expire": 0, "st-sans": 1, "st-bientot": 2, "st-sortie": 3, "st-actif": 4 };
    const rows = etat.registre.slice().sort((a, b) => tri[classeStatut(a.statut)] - tri[classeStatut(b.statut)] || (a.expiration || "").localeCompare(b.expiration || ""));
    $("#tRegistre tbody").innerHTML = rows.length ? rows.map(r => `
      <tr class="${classeStatut(r.statut)}">
        <td><strong>${esc(r.ref)}</strong><br><small>${esc(r.emplacement)}</small></td>
        <td>${esc(r.poste)}</td>
        <td>${esc(r.decision)}</td>
        <td class="c">${esc(r.consentement)}</td>
        <td>${fmtDate(r.dernierContact)}</td>
        <td>${fmtDate(r.expiration) || "–"}</td>
        <td><span class="statut">${esc(r.statut)}</span></td>
        <td class="actions">
          ${r.consentement === "Oui" && !/embauch/i.test(r.decision) ? `<button class="lien" data-prolonger="${esc(r.ref)}" title="Le candidat a renouvelé son accord">Prolonger 1 an</button>` : ""}
          <button class="lien danger" data-purger="${esc(r.ref)}" title="Après avoir supprimé le fichier dans votre espace de stockage">CV supprimé</button>
        </td>
      </tr>`).join("")
      : `<tr><td colspan="8" class="vide">Registre vide. Importez votre registre CSV ou reportez des décisions depuis le classement.</td></tr>`;
  }
  $("#tRegistre").addEventListener("click", e => {
    const p = e.target.dataset.prolonger, s = e.target.dataset.purger;
    if (p) {
      const r = etat.registre.find(x => x.ref === p);
      r.dernierContact = aujourdhui(); toast(`${p} : conservation prolongée jusqu'au ${fmtDate(ajouterJours(aujourdhui(), CONSERVATION_JOURS))}.`);
    }
    if (s) {
      if (!confirm(`Confirmez-vous avoir supprimé le CV ${s} de votre espace de stockage (et de la corbeille) ?`)) return;
      const r = etat.registre.find(x => x.ref === s);
      etat.journal.push({ ref: s, dateSuppression: aujourdhui(),
        motif: r.statut.startsWith("EXPIRÉ") ? "Durée de conservation atteinte" : r.statut.startsWith("Sans") ? "Absence de consentement" : r.statut.startsWith("Sortir") ? "Embauche (dossier du personnel)" : "Demande du candidat / autre" });
      etat.registre = etat.registre.filter(x => x.ref !== s);
    }
    rendreRegistre();
  });

  $("#fRegistre").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const lignes = parseCSV((await f.text()).replace(/^﻿/, ""));
      const tete = lignes.shift().map(h => norm(h).trim());
      const idx = ENTETES_REG.map(h => tete.indexOf(norm(h)));
      if (idx[0] < 0) throw new Error("colonne « Référence » introuvable");
      etat.registre = lignes.filter(l => l.some(x => x.trim())).map(l => {
        const o = {}; CLES_REG.forEach((k, i) => o[k] = idx[i] >= 0 ? (l[idx[i]] || "").trim() : "");
        o.dernierContact = dateISO(o.dernierContact); return ligneRegistre(o);
      });
      toast(`${etat.registre.length} ligne(s) importée(s).`); rendreRegistre();
    } catch (err) { toast("Registre illisible : " + err.message); }
    e.target.value = "";
  });
  $("#btnExportRegistre").addEventListener("click", () => {
    const rows = etat.registre.map(r => CLES_REG.map(k => k === "dernierContact" || k === "expiration" ? fmtDate(r[k]) : r[k]));
    telecharger(`registre-vivier-${aujourdhui()}.csv`, csv([ENTETES_REG, ...rows]), "text/csv;charset=utf-8");
  });
  $("#btnExportJournal").addEventListener("click", () => {
    if (!etat.journal.length) return toast("Aucune suppression enregistrée pendant cette session.");
    telecharger(`journal-purge-${aujourdhui()}.csv`,
      csv([["Référence", "Date de suppression", "Motif"], ...etat.journal.map(j => [j.ref, fmtDate(j.dateSuppression), j.motif])]),
      "text/csv;charset=utf-8");
  });

  /* ---------------- CSV (séparateur « ; » pour Excel FR) ---------------- */
  function csv(rows) {
    return "﻿" + rows.map(r => r.map(v => {
      const s = String(v ?? "");
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(";")).join("\r\n");
  }
  function parseCSV(txt) {
    const sep = (txt.split(/\r?\n/)[0].match(/;/g) || []).length >= (txt.split(/\r?\n/)[0].match(/,/g) || []).length ? ";" : ",";
    const out = []; let row = [], cell = "", q = false;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      if (q) { if (ch === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && txt[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); out.push(row); }
    return out;
  }
  function dateISO(s) {
    s = (s || "").trim();
    let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = s.match(/^\d{4}-\d{2}-\d{2}$/); return m ? s : aujourdhui();
  }

  /* ---------------- Rendu global ---------------- */
  function rendreTout() { rendreGrille(); rendreCandidats(); rendreClassement(); rendreRegistre(); }
  rendreTout();
})();
