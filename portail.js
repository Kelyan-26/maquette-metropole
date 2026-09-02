/**
 * Porte d'entrée de la maquette en ligne.
 *
 * Le dépôt est public — GitHub Pages l'impose sur le plan gratuit — donc les
 * données ne partent que chiffrées. Ce fichier demande la phrase de passe,
 * déchiffre `donnees.enc.json` dans le navigateur, pose `window.SEED_DATA`,
 * puis charge l'application.
 *
 * Rien n'est envoyé nulle part : le déchiffrement a lieu sur le poste du
 * lecteur. Une phrase de passe fausse ne donne aucun indice — AES-GCM
 * échoue sans rien révéler du contenu.
 */
(function () {
  const FICHIER = 'donnees.enc.json';
  const CLE_SESSION = 'maquette-phrase';

  // ⚠️ Verrou indispensable. Pour démarrer app.js — qui s'initialise sur
  // DOMContentLoaded, déjà passé — on redéclenche cet événement. Or ce
  // fichier écoute lui-même DOMContentLoaded : sans ce verrou, il se
  // rappelle, redéchiffre, recharge l'application, redéclenche… et la page
  // se réinitialise en boucle.
  let demarre = false;

  const $ = (id) => document.getElementById(id);
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function derive(phrase, sel, iterations) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: sel, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }

  async function dechiffre(enveloppe, phrase) {
    const cle = await derive(phrase, b64(enveloppe.salt), enveloppe.iterations);
    const clair = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64(enveloppe.iv) }, cle, b64(enveloppe.ciphertext));
    return JSON.parse(new TextDecoder().decode(clair));
  }

  function message(txt, type) {
    const el = $('porte-message');
    if (!el) return;
    el.textContent = txt || '';
    el.className = 'porte-message' + (type ? ' est-' + type : '');
  }

  function chargeApplication() {
    if (demarre) return;
    demarre = true;
    const s = document.createElement('script');
    s.src = 'app.js';
    s.onload = () => {
      // app.js s'initialise sur DOMContentLoaded, déjà passé à ce stade :
      // on le déclenche nous-mêmes.
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
      document.body.classList.remove('porte-fermee');
      const porte = $('porte');
      if (porte) porte.remove();
    };
    s.onerror = () => message("L'application n'a pas pu être chargée.", 'erreur');
    document.body.appendChild(s);
  }

  async function ouvre(phrase, silencieux) {
    if (!phrase || demarre) return false;
    message('Déchiffrement…', 'attente');
    try {
      const rep = await fetch(FICHIER, { cache: 'no-store' });
      if (!rep.ok) throw new Error('fichier absent');
      const enveloppe = await rep.json();
      window.SEED_DATA = await dechiffre(enveloppe, phrase);
    } catch (e) {
      if (!silencieux) {
        message(e.message === 'fichier absent'
          ? "Le fichier de données est introuvable sur l'hébergement."
          : 'Phrase de passe incorrecte.', 'erreur');
      }
      try { sessionStorage.removeItem(CLE_SESSION); } catch (_) {}
      return false;
    }
    try { sessionStorage.setItem(CLE_SESSION, phrase); } catch (_) {}
    chargeApplication();
    return true;
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (demarre) return;   // relance provoquée par notre propre dispatch
    const loader = $('app-loader');
    if (loader) loader.classList.add('hidden');

    const form = $('porte-form');
    if (form) {
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        ouvre($('porte-phrase').value.trim(), false);
      });
    }

    // Une phrase déjà saisie dans cet onglet évite de la redemander
    // à chaque rechargement pendant une présentation.
    let memorisee = null;
    try { memorisee = sessionStorage.getItem(CLE_SESSION); } catch (_) {}
    if (memorisee) {
      const ok = await ouvre(memorisee, true);
      if (!ok) message('');
    }
    const champ = $('porte-phrase');
    if (champ) champ.focus();
  });
})();
