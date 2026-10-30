
# ERPLibre Home Mobile

Application mobile Odoo Owl + Capacitor pour ERPLibre.

Les sections suivantes décrivent le bon usage des scripts fournis, ainsi que les erreurs que vous pourriez rencontrer en initialisant un nouveau projet et la façon de les traiter.

La documentation technique complète se trouve dans [doc/README.md](./doc/README.md).

## Installation

Pour installer les dépendances npm nécessaires au développement de l'application web, lancer :

```
npm install
```

## Lancer l'application

Ces commandes lancent l'application sur Android, mais c'est également possible sur iOS si la plateforme est correctement installée.

```bash
# Builds and syncs the application
npm run build && npx cap sync

# Runs the app (android)
npx cap run android

# Runs the app (iOS)
npx cap run ios
```

Pour une façon plus commode de compiler, synchroniser et lancer l'application, voir la section [Script BSR](#script-bsr).

## Supprimer node_modules

Il arrive qu'on veuille supprimer le dossier node_modules et réinstaller les paquets npm pour résoudre un problème.

> [!CAUTION]
> En supprimant `node_modules`, vous empêchez les paquets npm comme `@odoo/owl` ou `@capacitor/app` de fonctionner jusqu'à leur réinstallation.

```bash
# Delete node_modules
rm -rf node_modules

# Reinstall packages
npm install
```

## Élagage

Pour ne désinstaller de node_modules que les paquets qui ne sont pas de véritables dépendances, la commande prune est disponible.

```
npm prune
```

## Tests

Le projet utilise [Vitest](https://vitest.dev/) pour les tests unitaires.

### Lancer les tests

Depuis la racine du dépôt :

```bash
./mobile/run_tests.sh
```

Ou directement depuis `erplibre_home_mobile` :

```bash
npm test
```

### Fichiers de test

Les fichiers de test se trouvent dans `src/__tests__/` :

| Fichier | Couverture |
|---------|-----------|
| `appService.test.ts` | CRUD applications, régression d'initialisation |
| `databaseService.test.ts` | Opérations SQLite (applications, notes) |
| `dataMigration.test.ts` | Migration SecureStorage → SQLite |
| `migrationService.test.ts` | Runner de migrations, stockage de version |
| `migrationPopup.test.ts` | Dialogue de notification de migration |
| `noteService.test.ts` | CRUD notes, tags, intents |

### Mocks

Les plugins Capacitor sont mockés dans `src/__mocks__/` :

| Mock | Rôle |
|------|------|
| `capacitor-secure-storage-plugin.ts` | Stockage clé/valeur en mémoire |
| `@capacitor/dialog.ts` | alert/confirm bouchonnés |
| `@capacitor/core.ts` | Cœur de Capacitor bouchonné |
| `@capacitor-community/sqlite.ts` | SQLite en mémoire via `sql.js` |
| `@odoo/owl.ts` | EventBus d'Owl bouchonné |

## Script BSR

BSR signifie _Build_, _Sync_ et _Run_ — les actions courantes du développement. Comme il faut souvent compiler l'application et la lancer sur un appareil précis, ce script existe pour accélérer ce cycle.

Voici les commandes

`npm run bsr` : compile l'application et la démarre sur localhost (web)

`npm run bsr web` : identique à `npm run bsr`

`npm run bsr ios` : compile et synchronise l'application, puis la lance sur un appareil iOS.

`npm run bsr android` : compile et synchronise l'application, puis la lance sur un appareil Android.

## Script GenComp

Cette section détaille le script GenComp.

GenComp signifie _Generate Component_. Le script permet de générer le squelette d'un composant Owl, pour commencer plus vite à programmer ses fonctionnalités.

### Commandes

`npm run gencomp <nom>` : génère le composant dans le dossier `components`
`npm run gencomp <nom> <chemin>` : génère le composant dans le dossier indiqué
`npm run gencomp <nom> <chemin> <add-css>` : génère le composant dans le dossier indiqué, et omet le fichier CSS si add-css vaut `false`.

### Paramètres

#### Nom

Nom du composant ; « Component » lui sera ajouté automatiquement.

#### Chemin

Chemin du composant, relatif au dossier `components`.

Un chemin `notes/item` crée le composant dans `src/components/notes/item`.

Paramètre optionnel.

#### AddCSS

S'il vaut `false`, le fichier CSS n'est pas créé et n'est pas ajouté aux imports de `src/css/components.scss`.

Paramètre optionnel.

### Exemple

`npm run gencomp noteItem notes/item false` crée le composant `NoteItem` dans `src/components/notes/item` sans le fichier CSS.

## Scripts shell

Cette section détaille les scripts shell fournis, pour mieux les comprendre et les employer à bon escient.

<details>
<summary>Déplier</summary>

### create.sh

Script généralisé pour créer un projet Odoo Owl/Capacitor et y ajouter une plateforme donnée. Sans argument de plateforme, il ajoute Android par défaut et se comporte donc comme `create-android.sh`.

### create-android.sh

Crée un projet Odoo Owl/Capacitor et y ajoute la plateforme Android.

### create-ios.sh

Crée un projet Odoo Owl/Capacitor et y ajoute la plateforme iOS.

### add-android.sh

Ajoute la plateforme Android au projet.

### add-ios.sh

Ajoute la plateforme iOS au projet.

### build-android.sh

Compile le projet Capacitor. Produit une application Android exécutable et signée.

### build-ios.sh

Compile le projet Capacitor. Produit une application iOS exécutable et signée.

### sync.sh

Copie le projet Odoo Owl compilé vers toutes les plateformes et met à jour les plugins natifs et les dépendances dans `package.json`.

</details>

## Erreurs

Cette section recense les erreurs susceptibles de survenir en initialisant un nouveau projet Odoo Owl/Capacitor, que ce soit avec les scripts des sections précédentes ou en tapant les commandes à la main. Les solutions sont également fournies.

<details>
<summary>Déplier</summary>

## iOS

### `build-ios.sh` ou `npx cap build ios` :

#### Erreur :

error: Signing for "App" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'App' from project 'App')

#### Solution :

https://forum.ionicframework.com/t/ionic-capacitor-failed-ios-build/177400/2

## Android

### `build-android.sh` ou `npx cap build android`

</details>

## Documentation Odoo Owl

[Dépôt GitHub officiel d'Odoo Owl](https://github.com/odoo/owl/tree/master?tab=readme-ov-file#documentation)

## Notifications du clavardage

Options › Notifications du clavardage fait sonner le téléphone pour un message
du clavardage quand l'app est fermée, sur Android. Odoo 18 publie un push
chiffré sur un sujet d'un serveur ntfy que vous faites tourner ; le téléphone
le lit, le déchiffre et affiche la notification. Le module
`erplibre_mobile_chat` n'est pas requis (la version 1.5 ajoute l'identifiant du
message, le push « lu » et le bouton 👍 ; la version 1.6 ajoute, pour chaque
destinataire, si l'utilisateur est mentionné et si un de ses navigateurs est
actif, que lisent le filtre du téléphone et son réglage du navigateur ; sans
lui, tout le reste fonctionne) ; le téléphone s'enregistre lui-même auprès
d'Odoo, sous sa propre session.

1. **Préparer ntfy** sur la machine qui le fait tourner, dans `TODO › Déployer
   › Préparer ntfy pour ERPLibre mobile`, sur cette machine ou par ssh. La
   commande pose les règles d'accès (Odoo écrit sans compte sur `up*`, chaque
   téléphone ne lit que son préfixe avec un jeton en lecture seule) et affiche
   un lien et son code QR. Un nom de téléphone déjà préparé est refusé : en
   choisir un autre, ou révoquer ce téléphone et le préparer de nouveau.
   « Révoquer un téléphone », dans le même menu, supprime le compte et le jeton
   d'un téléphone : son jeton cesse aussitôt de fonctionner, mais Odoo garde
   ses appareils et continue de publier sur leurs sujets jusqu'à ce que l'app
   retire le compte ou applique un nouveau lien. « Retirer ntfy », dans l'app,
   oublie le lien et désenregistre le téléphone d'Odoo.
2. **Scanner le code QR ou coller le lien** dans Options › Notifications du
   clavardage, pour chaque compte. Le lien porte deux adresses quand Odoo
   atteint ntfy autrement que le téléphone (le téléphone par le réseau local,
   Odoo par sa boucle locale ou un nom interne) : la seconde va dans « Adresse
   de ntfy vue d'Odoo » et c'est celle sur laquelle Odoo publie ; la laisser
   vide quand les deux sont identiques.
3. **Un ntfy en http sur le réseau local** demande deux choses : « Autoriser
   http » dans Options › Synchronisation Odoo, et un APK construit avec
   `-PlanCleartext` (`./gradlew :app:assembleDebug -PlanCleartext`), car Android
   bloque le http autrement. Un ntfy en https n'a besoin ni de l'un ni de l'autre.
4. **Choisir un niveau** (une installation qui n'a jamais choisi tourne au
   niveau 3) : 1 temps réel (connexion permanente), 2 temps réel sur Wi-Fi ou
   en charge et aux 15 minutes sinon, 3 aux 15 minutes, 4 chaque heure,
   5 désactivé. Les niveaux 1 et 2 demandent à Android de laisser l'app hors de
   l'optimisation de la batterie ; si l'utilisateur refuse, l'app le dit et
   propose le niveau 3. Une seule notification permanente, partagée avec la
   passerelle SMS (son ancien canal « Passerelle SMS » est remplacé) et à la
   priorité minimale, s'affiche tant qu'une connexion permanente tourne.
   L'app peut monter d'elle-même à un niveau plus économe (« Économiser
   automatiquement », plus bas).
5. **L'écran verrouillé**, par serveur : « Masqué quand verrouillé » (le défaut)
   est garanti. Quand Android masque le contenu sensible sur l'écran verrouillé,
   la notification y montre « Nouveau message — <serveur> », et l'auteur et le
   texte une fois déverrouillé ; quand Android montre tout le contenu, ou que
   l'app ne peut pas lire ce réglage, la notification n'apparaît pas du tout sur
   l'écran verrouillé et s'affiche normalement une fois déverrouillé. Le choix
   se fait à chaque affichage : une notification dessinée pendant qu'Android
   masquait le contenu garde cette forme si l'utilisateur change ensuite le
   réglage d'Android, jusqu'à ce qu'elle soit affichée de nouveau. « Jamais
   affiché » et « Toujours affiché » font ce qu'ils disent.
6. **Les actions**, depuis la notification elle-même, sur une notification de
   clavardage (une discussion directe, un groupe ou un canal ; une notification
   de boîte de réception, un sommaire ou un état n'en a aucune). Android
   n'affiche que trois boutons : deux sont toujours là et le troisième dépend
   du message :
   - « Répondre » saisit un message qui est publié dans la conversation au nom
     de l'utilisateur ;
   - « Marquer lu » marque la conversation lue dans Odoo jusqu'au plus récent
     message affiché, même quand l'envoi de « lu » est
     désactivé dans Options › Clavardage, et retire de la boîte de réception
     d'Odoo les @mentions de cette conversation jusqu'à ce message (rien
     d'autre n'en sort) ;
   - « 👍 » réagit au plus récent message reçu (la réponse de l'utilisateur ne
     compte pas), offert quand ce message a un identifiant, que seul le module
     1.5 pousse ; sinon « Muet 1 h » prend sa place (et la reprend une fois un
     👍 envoyé).

   Les boutons sont offerts dans tous les modes d'écran verrouillé, « Jamais
   affiché » compris (le texte y reste masqué). Sur tout serveur sauf
   « Toujours affiché », Android 12 et suivants demande de déverrouiller avant
   qu'une action s'exécute. Chaque action est écrite dans un magasin local
   scellé avant tout appel réseau : elle n'est jamais perdue ni faite deux fois. Une réponse porte
   un identifiant client (le module le garde ; sans le module, le téléphone
   cherche d'abord le marqueur caché du corps, après une fenêtre de calme de
   3 minutes), et marquer lu, mettre en sourdine et 👍 sont des états cibles
   qu'une répétition laisse intacts. Les réponses à une même conversation
   partent dans l'ordre où elles ont été saisies. Une action qui échoue pour
   une raison de réseau est réessayée avec un délai croissant.
   Avant chaque action, le téléphone vérifie que le serveur connaît encore la
   session, car Odoo répond « marquer lu » par un succès sans rien faire quand
   la session est morte. Une session morte, un refus, deux messages trouvés sous
   un même marqueur ou 24 heures d'échecs confient l'action à l'app : Android
   interdit d'ouvrir l'app depuis une action en arrière-plan, alors le téléphone
   affiche une notification par serveur, « Ouvrez l'app pour terminer une
   action — <serveur> », et l'app se reconnecte et envoie l'action, une fois, à
   son prochain démarrage. Une action qui ne peut même pas être enregistrée
   affiche « Action non envoyée — <serveur> ».

**Les réglages d'Odoo, changés depuis l'app.** Ce qu'Odoo pousse se décide par
les mêmes réglages que dans le navigateur, et l'app les lit et les change.
Options › Clavardage, par serveur, offre « Canaux (réglage d'Odoo) » : « Tous
les messages », « Mentions seulement » ou « Rien ». Odoo ne l'applique qu'aux
canaux, comme le dit la ligne en dessous : « Les discussions et les groupes
sonnent toujours ; pour les faire taire, utilisez la sourdine ». L'écran
d'information d'un canal offre « Ce canal (réglage d'Odoo) », avec « Par défaut
({value}) » qui nomme la valeur générale ; les discussions et les groupes
n'offrent que la sourdine, puisqu'Odoo ignore leur propre réglage. Un
changement attend dans la file hors ligne, et un changement fait dans le
navigateur arrive dans l'app par le bus d'Odoo.

**Un changement fait juste avant de quitter l'app.** Ce que l'app envoie à
Odoo depuis ses écrans (un message, une conversation marquée lue, un réglage
de notification) passe par une file conservée sur le téléphone, et
cette file tourne dans la page de l'app. Environ une minute après que l'app
quitte l'écran (Accueil, une autre app), la WebView d'Android gèle cette page :
un changement mis en file juste avant de partir peut attendre que l'app
revienne au premier plan, puis part dans l'ordre. Rien n'est perdu. Les
actions d'une notification (répondre, marquer lu, sourdine, 👍) n'en sont pas
touchées : le code natif les exécute, l'app ouverte ou non.

**Ce que le téléphone laisse passer, par serveur.** Par-dessus les réglages
d'Odoo, la carte de chaque compte dans Options › Notifications du clavardage
porte un filtre qui ne peut qu'être plus strict. « Conversations » : « Tout ce
qu'Odoo envoie » (le défaut), « Mentions et messages directs » (les
discussions et les groupes sonnent toujours, un canal seulement quand le
message mentionne l'utilisateur, `@everyone` compris) ou « Rien de ce
serveur » (l'enregistrement reste et Odoo pousse toujours ; le téléphone
n'affiche rien, pas même un sommaire). Sans le module 1.6, le push ne dit pas
si l'utilisateur est mentionné : « Mentions et messages directs » laisse alors
passer tout message de canal, et la carte dit « filtre approximatif sans le
module 1.6 ». « Boîte de réception (enregistrements et activités) » est
activée par défaut ; désactivée, aucune notification d'enregistrement ou
d'activité ne sonne, une mention comprise, sauf si « Sonner quand même si on
me mentionne dans un enregistrement » est cochée en dessous (désactivée par
défaut ; elle demande le module 1.6).

**Les heures calmes, par serveur.** « Heures calmes » est désactivé par
défaut, de 22:00 à 07:00 une fois activé ; la fenêtre peut passer minuit, et
un début égal à la fin est refusé. Pendant la fenêtre, dans le fuseau du
téléphone, les notifications du clavardage, de la boîte de réception et le
sommaire arrivent sans son ni vibration ; aucune n'est retirée.

**Quand un navigateur est actif**, un seul réglage pour tout le téléphone,
appliqué à chaque serveur qui a le module : « Sonner tout de suite »,
« Attendre 10 s » (le défaut) ou « Ne pas envoyer au téléphone ». Un
navigateur est actif quand l'utilisateur y a eu une activité, connecté, dans
les 5 dernières minutes (le seuil propre au module ; le statut qu'Odoo affiche
garde son délai). Avec « Attendre 10 s », un message de clavardage poussé
pendant qu'un navigateur est actif est retenu 10 secondes et retiré s'il est
lu dans le navigateur entre-temps, sinon affiché. Un message retenu survit au
processus : il est affiché après le prochain rattrapage du ntfy, à moins que
sa lecture soit arrivée entre-temps. Quand la batterie fait monter le niveau
au-delà de 2, les messages retenus sont affichés une dizaine de secondes plus
tard, avant l'arrêt du service permanent ; seule la mort du processus (un
balayage sur certains téléphones, une fin forcée faute de mémoire) les laisse
à la prochaine relève périodique (15 minutes, davantage sous le Doze
d'Android). Un passage au niveau 5 les retire. Un message retenu qui ne peut
plus être lu ni affiché à son heure est compté dans le panneau d'état des
options (« Messages retenus perdus : {n} »). « Ne pas envoyer au téléphone »
demande au module 1.6 de ne rien pousser au téléphone tant qu'un navigateur
est actif. Avec le module 1.5, « Attendre 10 s » sonne tout de suite, et « Ne
pas envoyer au téléphone » ne joue que dans la minute environ qui suit
l'ouverture du navigateur (le serveur de ce module ne voit le navigateur qu'à
sa connexion ; la 1.6 applique la règle des 5 minutes d'activité), ce que dit
la carte ; sans le module, tout push sonne. Chaque
carte dit ce qui s'applique sur son serveur (« Navigateur actif, sur ce
serveur : {mode} »), et « pas encore appliqué sur ce serveur » tant que le
serveur n'a pas appris un changement.

**Économiser automatiquement**, activé par défaut, pour tout le téléphone :
« Un niveau de plus sous » un pourcentage de batterie (30 % par défaut) et
« Deux niveaux de plus sous » un autre (15 % par défaut), chacun choisi parmi
aucun, 10, 15, 20, 30, 40 et 50 %. Chaque seuil fait ce que dit son libellé :
sous le second, le niveau monte de deux même quand le premier est « aucun » ou
plus bas. La montée ne dépasse jamais le niveau 4 : les notifications ne
s'arrêtent qu'à un niveau 5 choisi par l'utilisateur. En remontant, une montée
n'est relâchée que 5 points au-dessus de son seuil (montée sous 15 %, retour à
20 % ou plus) : une jauge qui oscille autour d'un seuil ne fait monter qu'une
fois ; la dernière montée est conservée, et une relève lancée après la mort du
processus de l'app la poursuit. L'économiseur de batterie d'Android veut dire
le niveau 3 au moins, même l'interrupteur désactivé, et cesse avec lui.
Branché, le téléphone revient aussitôt au niveau choisi, quel que soit le
pourcentage. Pendant une montée, les options affichent « En ce moment : niveau
{level} ({why}) », la raison étant « économiseur de batterie » ou « batterie
passée sous {pct} %, jusqu'à {release} % ou au branchement », vrai sous le
seuil comme dans les 5 points qui la retiennent encore. Une tâche attend le chargeur : le service permanent revient une
fois branché sans attendre la relève aux 15 minutes (jusqu'à 15 minutes quand
Android diffère cette tâche).

Odoo ne réessaie jamais un push, et
rien ne marque un message comme lu : un téléphone muet plus longtemps que le
cache de ntfy, ou un compte sans ntfy, reçoit un sommaire par serveur, compté
sur les compteurs de non lus d'Odoo. Odoo publie dans la requête qui poste le
message (quand moins de 5 appareils sont parmi les destinataires) : un ntfy qui
accepte la connexion sans jamais répondre retarde un envoi jusqu'à 5 secondes
par appareil ; un port fermé échoue aussitôt. Sans le module 1.5, ntfy répond
200 là où Odoo attend 201, si bien que chaque push réussi inscrit dans le
journal d'Odoo un avertissement qui porte le sujet : traiter ce journal comme
sensible.

Le module 1.5 (facultatif) marque les appareils du téléphone par
`/erplibre_mobile_chat/push/device`, que l'app appelle après chaque
enregistrement. Leurs push portent alors l'identifiant du message et le type de
canal, partent après la validation de la transaction (2 secondes au plus par
appareil) et sont acceptés sur le 200 de ntfy sans journaliser le sujet ; un push « lu » retire aussitôt la
notification quand la conversation est lue ailleurs, et un push « boîte de
réception faite » retire celle d'un enregistrement traité ailleurs (seuls les
appareils marqués du téléphone les reçoivent). Le module marque chaque
appareil du réglage du navigateur du téléphone ; le module 1.6 ajoute aux
push, pour chaque destinataire, si l'utilisateur est mentionné et si un de ses
navigateurs est actif, que lisent le filtre et « Attendre 10 s ». L'app envoie
le réglage sous la forme que lit le niveau du module du serveur : Odoo 18
ignore un argument de route qu'il ne connaît pas, si bien qu'un serveur 1.5
prendrait l'argument de la 1.6 et sonnerait. Sans le module 1.5,
il n'y a pas de 👍 (une réaction trouvée par l'heure pourrait tomber sur un
autre message), « Marquer lu » trouve le plus récent message par sa date, et
une notification part au prochain contrôle ou à l'ouverture de l'app.

La propriété de construction `-PnoChatRealtime` laisse le service permanent hors
de l'APK (une version sans les niveaux 1 et 2, pour un magasin qui le refuse).