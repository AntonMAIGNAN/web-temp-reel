# Web en temps réel

Serveurs pair-à-pair (`app-1`, `app-2`, …) qui se découvrent via un tracker, font un handshake sécurisé, puis s'échangent des messages **chiffrés**, lisibles uniquement par le serveur destinataire du lien.

```
common/     code partagé (routes, handshake, crypto, broker)
app-1/      serveur (port 3000)
app-2/      serveur (port 3001)
postman/    collection Postman
```

Le tracker est dans un autre repo (`web-temp-reel-B`, port 4000).

## Lancer

Prérequis : Node.js ≥ 22.18.

```bash
cd common && npm install
```

```bash
cd app-1 && npm install && npm start
```

```bash
cd app-2 && npm install && npm start
```

Variables d'environnement (voir `app-*/.env.example`) : `PORT`, `PEER_ID`, `BROKER_URL` (URL du tracker), `BASE_URL`.

## Tests

```bash
cd common && node --test --test-timeout=20000 test/*.test.ts
```

## Protocole

### Sécurité

Chaque serveur génère au démarrage une paire de clés **X25519**, en mémoire uniquement. Sa clé publique est envoyée sur **chaque requête** :

```
Signature-Input: sig1=();keyid="<clé publique X25519, 32 octets en base64url>"
```

Forme JSON : `{ "sig1": { "keyid": "<clé publique>" } }`.

- `401` : header absent, mal formé, ou `keyid` invalide (l'émetteur n'est pas identifié).
- `403` : un serveur déjà connu présente une autre clé que celle échangée au handshake.
- Exemptées : `POST /register` (push du tracker), `POST /broker/syn/:id` et `POST /broker/send/:id`.

Au handshake, chaque serveur combine **sa clé privée** avec **la clé publique de l'autre** (Diffie-Hellman) : les deux obtiennent le même secret, sans l'envoyer. Les messages `/ingress` sont chiffrés avec ce secret :

```json
{
  "action": "chat",
  "metadata": {
    "source": "http://localhost:3000",
    "target": "http://localhost:3001",
    "timestamp": "2026-11-07T13:05:32.265Z"
  },
  "payload": {
    "enc": { "iv": "<base64>", "ct": "<base64>", "tag": "<base64>" }
  }
}
```

`metadata` reste lisible (routage, doublons) mais elle est protégée : si elle est modifiée en route, le déchiffrement échoue (`400`).

### Workflows

**Enregistrement (tracker)**

1. Au démarrage, le serveur A envoie `POST <tracker>/register` `{ id, url }`.
2. Le tracker retient `id → url` et pousse la liste complète `[{ id, url }]` à tous les serveurs (`POST <serveur>/register`).
3. Chaque serveur remplace sa liste de pairs (en gardant l'entrée `broker`).
4. Un serveur qui ne reçoit pas la liste après 3 essais est retiré du tracker, et la nouvelle liste est repoussée aux autres.
5. À l'arrêt (SIGINT/SIGTERM), le serveur envoie `DELETE <tracker>/unregister/:id`.

**Handshake (identifié par le header `Origin`)**

Lancé avec `POST <A>/broker/syn/:id` (commande locale) : le serveur A lit l'URL de `id` dans sa liste de pairs, note qu'il l'a contacté, puis envoie un `/syn` classique :

```
A ──POST /syn──────▶ B   B enregistre la clé de A, répond 202
A ◀─POST /syn-ack─── B   A enregistre la clé de B, répond 202
A ──POST /ack──────▶ B   B répond 204 : connexion établie des deux côtés
```

Chaque étape porte la clé publique de l'émetteur ; à la fin, serveur A et serveur B ont le même secret. Un nouveau `/syn` ou `/syn-ack` peut remplacer une clé déjà connue (serveur redémarré).

- `/syn-ack` n'est accepté que d'un serveur à qui on a envoyé un `/syn` (sinon `403`).
- `/syn-ack` et `/ack` sont réessayés 3 fois (500 ms entre deux) ; toujours en échec, le handshake est oublié (`500`).
- `/syn` sans réponse : on oublie qu'on a essayé de contacter le serveur.
- Timeout de 15 s par requête.

**Keep-alive**

Toutes les 10 s, chaque serveur envoie `GET /health` (avec `Origin`) à ses pairs connectés ; le pair répond `202` et rappelle `POST /pong`.

- En cas d'erreur : back-off exponentiel (5 essais, 30 s max entre deux). Toujours en erreur : le pair est **oublié** (connexion, clé et secret).
- Chaque serveur compte les `/health` envoyés à un pair depuis son dernier `/pong` ; chaque `/pong` remet le compteur à zéro. Après 5 `/health` sans `/pong`, le pair est oublié.

**Envoi d'un message** (`POST /broker/send/:id`)

1. Résolution de l'id : liste de pairs, sinon on demande aux voisins (`POST /broker/lookup/:id`, qui transmettent à leurs propres voisins ; un `reqId` déjà vu stoppe les boucles).
2. Handshake si besoin, puis envoi **direct** chiffré sur `POST <pair>/ingress`.
3. Si l'envoi direct échoue : **relais** via un voisin qui connaît le pair (`POST <voisin>/broker/relay/:id`). Le voisin déchiffre avec le secret A↔voisin et re-chiffre avec le secret voisin↔destinataire.

**Tracker arrêté** : chaque serveur vérifie le tracker toutes les 15 s. Les pairs déjà connus continuent de communiquer (direct ou relais) ; quand le tracker revient, le serveur se ré-enregistre.

### Routes

Toutes les routes peuvent aussi répondre `500` (erreur serveur). Body d'erreur : `{ "error": "<message>" }`.

| Service | Route                                          | Réponses                                        |
| ------- | ---------------------------------------------- | ----------------------------------------------- |
| tracker | `POST /register` `{ id, url }`                 | `204`, `400`                                    |
| tracker | `DELETE /unregister/:id`                       | `204`, `404`                                    |
| serveur | `POST /register` `[{ id, url }]`               | `204`, `400`, `403`                             |
| serveur | `POST /syn`                                    | `202`, `400`, `401`, `500`                      |
| serveur | `POST /syn-ack`                                | `202`, `400`, `401`, `403`, `500`               |
| serveur | `POST /ack`                                    | `204`, `400`, `401`, `403`                      |
| serveur | `POST /forget`                                 | `204`, `400`, `401`, `403`                      |
| serveur | `GET /health`                                  | `202`, `400`, `401`, `403`, `500`               |
| serveur | `POST /pong`                                   | `204`, `400`, `401`, `403`                      |
| serveur | `POST /ingress`                                | `201`, `208`, `400`, `401`, `403`               |
| broker  | `POST /broker/syn/:id`                         | `202`, `404`, `500`                             |
| broker  | `POST /broker/send/:id` `{ action, payload? }` | `202`, `400`, `404`, `502`                      |
| broker  | `POST /broker/lookup/:id` `{ reqId }`          | `200 { id, url }`, `400`, `401`, `403`, `404`   |
| broker  | `POST /broker/relay/:id` (body `/ingress`)     | `202`, `400`, `401`, `403`, `404`, `502`, `508` |

### Écarts avec le protocole commun

- **Sécurité** : toutes les routes serveur → serveur exigent `Signature-Input` (sinon `401`). `GET /health` sans `Origin` répond donc `401` au lieu de `204`.
- **`/ingress`** : le `payload` doit être chiffré (`{ enc }`), un payload en clair est refusé (`403`). Le format du body reste `{ action, metadata, payload }`.
- **Partie C** : `/broker/syn/:id` est une commande locale sur le serveur qui initie ; il démarre par un `/syn` classique (pas de `/broker/syn-ack`). Ajout de `/broker/send`, `/broker/lookup` et `/broker/relay`.
