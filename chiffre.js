#!/usr/bin/env node
/**
 * Chiffre les données de la maquette vers donnees.enc.json.
 *
 * Même procédé que Soft Landing PAC : le dépôt GitHub est public parce que
 * Pages l'impose sur le plan gratuit, donc le seul fichier qui part en ligne
 * est chiffré. Sans la phrase de passe, il est illisible.
 *
 * `data-seed.js` reste en local et n'est jamais versionné (voir .gitignore).
 *
 *   MAQUETTE_PASSPHRASE='...' node chiffre.js
 *   node chiffre.js            → demande la phrase de passe
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ITERATIONS = 250000;
const KEY_LENGTH = 32;
const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'data-seed.js');
const TARGET = path.join(ROOT, 'donnees.enc.json');
const PREFIXE = 'window.SEED_DATA = ';

function demandePhrase() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Phrase de passe : ');
    rl.output.write = () => {};
    rl.question('', (rep) => {
      rl.close();
      process.stdout.write('\n');
      rep ? resolve(rep) : reject(new Error('Phrase de passe vide.'));
    });
  });
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source introuvable : ${SOURCE}`);
    process.exit(1);
  }

  const brut = fs.readFileSync(SOURCE, 'utf8').trim();
  if (!brut.startsWith(PREFIXE)) {
    console.error('data-seed.js ne commence pas par le préfixe attendu.');
    process.exit(1);
  }
  const json = brut.slice(PREFIXE.length).replace(/;$/, '');
  let donnees;
  try {
    donnees = JSON.parse(json);
  } catch (e) {
    console.error(`Données illisibles : ${e.message}`);
    process.exit(1);
  }

  const phrase = process.env.MAQUETTE_PASSPHRASE || (await demandePhrase());
  if (phrase.length < 12) {
    console.error('Phrase de passe trop courte : 12 caractères minimum.');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cle = crypto.pbkdf2Sync(phrase, salt, ITERATIONS, KEY_LENGTH, 'sha256');

  const cipher = crypto.createCipheriv('aes-256-gcm', cle, iv);
  const charge = Buffer.concat([
    cipher.update(JSON.stringify(donnees), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),   // WebCrypto attend le tag collé au chiffré
  ]);

  fs.writeFileSync(TARGET, JSON.stringify({
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: charge.toString('base64'),
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n');

  console.log(`donnees.enc.json écrit — ${donnees.entreprises.length} entreprises, `
    + `${(charge.length / 1024 / 1024).toFixed(2)} Mo chiffrés.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
