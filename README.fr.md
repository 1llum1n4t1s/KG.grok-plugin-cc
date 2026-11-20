[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Plugin Grok pour Claude Code et Codex

Exécutez Grok Build depuis Claude Code ou Codex pour des revues de code, des audits de dépôt, des recherches sur X, des tâches déléguées et la génération d'images. Ce projet est un fork de [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) ; voir [NOTICE](NOTICE).

## Prérequis et installation

Installez [Grok Build](https://x.ai/cli), connectez-vous ou configurez sa clé d'API, et installez Git 2.45 ou une version ultérieure (ou une build de Git avec `--no-lazy-fetch` rétroporté). Sous Windows, macOS et Linux, installez Bun 1.4.4 ou une version ultérieure, ou Node.js 22 ou une version ultérieure ; Bun est préféré lorsque les deux sont disponibles. L'utilisation de Grok est facturée au compte ou à la clé d'API utilisés. Grok doit prendre en charge `grok agent stdio` ; mettez-le à jour avec `grok update` si nécessaire.

Sous Windows, le plugin inclut des helpers natifs pour les runtimes ia32, x64 et arm64. Aucune installation de Rust ou de MSVC n'est requise.

Dans Claude Code :

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Pour Codex, exécutez :

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Démarrez une nouvelle tâche Codex pour charger ses skills. Si vous utilisez les deux hôtes, installez le plugin séparément dans chacun.

### Mises à jour

Claude Code désactive par défaut la mise à jour automatique pour les marketplaces tierces telles que `kagayoi-grok`. Pour l'activer, exécutez `/plugin` dans une session Claude Code, ouvrez l'onglet **Marketplaces**, sélectionnez `kagayoi-grok`, puis choisissez **Enable auto-update**. Claude Code actualise ensuite le marketplace après le démarrage d'une session et met à jour le plugin installé ; exécutez `/reload-plugins` ou démarrez une nouvelle session pour charger la nouvelle version. Pour mettre à jour immédiatement, exécutez plutôt `claude plugin update grok@kagayoi-grok` dans votre shell.

Pour Codex, exécutez `codex plugin marketplace upgrade kagayoi-grok` pour actualiser le marketplace, puis démarrez une nouvelle tâche Codex.

## Commandes

Claude Code expose `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:imagine`, `/grok:rescue`, `/grok:x` et `/grok:setup`. Dans Codex, sélectionnez le skill `grok:source-command-<name>` correspondant. La revue et l'audit sont en lecture seule ; rescue peut demander des modifications, tandis que la recherche sur X reste en lecture seule. `/grok:imagine <description>` demande à Grok Build de générer une image et la copie dans `grok-imagine/` dans l'espace de travail, ou dans `--output <path>` lorsque ce chemin reste dans l'espace de travail. Il ne modifie pas le reste du dépôt. Avec `grok login`, la génération utilise le quota hebdomadaire partagé de l'abonnement. Si `XAI_API_KEY` est défini, la commande s'arrête tant que `--allow-api-billing` n'est pas passé : les images d'API sont facturées aux tarifs xAI (`grok-imagine-image-2.0` est indiqué à partir de $0.04/img) et non sur ce quota. Setup vérifie l'authentification de Grok.

Sous Windows, utilisez `/grok:review --scope working-tree` pour examiner les modifications locales. Les portées `auto` et `working-tree` exigent un instantané Windows sûr et complet, et échouent s'il ne peut pas être collecté. Sous macOS/Linux, utilisez explicitement `/grok:review --scope branch` ou `--base <ref>` pour examiner les modifications validées ; les modifications non validées sont exclues du diff de comparaison, mais les fichiers environnants peuvent tout de même être lus depuis l'arborescence de travail. Utilisez `/grok:audit authentication` pour centrer un audit de l'ensemble du dépôt sur un sujet, quelle que soit la plateforme, ou `/grok:rescue <task>` pour déléguer une tâche. La revue, la revue contradictoire et l'audit acceptent également `--language <BCP 47 tag>`. Exécutez `/grok:setup` lorsque l'installation ou l'authentification échoue ; suivez l'erreur signalée et les instructions de connexion de Grok.

Chaque invocation lance une nouvelle session Grok au premier plan et renvoie directement son résultat. Utilisez l'interface propre à Grok pour poursuivre une conversation. Les revues automatiques ainsi que les anciennes commandes status, result, cancel, state-lock et task-resume ne sont plus prises en charge par le companion.

Le companion démarre le CLI Grok installé localement. Il vérifie les chemins lors des requêtes de fichiers ACP et applique une liste d'autorisations en lecture seule ; les tâches d'écriture explicitement demandées peuvent modifier l'espace de travail. Grok Build gère ses opérations intégrées sur le système de fichiers et le shell, l'accès externe et l'authentification. Le companion ne médie pas chaque opération d'E/S, ne fournit pas de sandbox au niveau du système d'exploitation et ne garantit pas une isolation complète des accès, y compris via des liens symboliques. Examinez la sortie et les modifications de Grok avant de vous y fier.

## Langue d'affichage

Les messages propres au companion (résultats de setup, titres de revue, diagnostics et aide) s'affichent dans la langue de votre environnement. Il vérifie `GROK_PLUGIN_LANGUAGE`, puis `LC_ALL`, `LC_MESSAGES` et `LANG`, puis la langue d'affichage du système, et se rabat sur l'anglais. Les langues prises en charge sont `ja`, `en`, `zh-CN`, `zh-TW`, `ko`, `es`, `fr`, `de` et `pt-BR`. Ce réglage est distinct de `--language`, qui définit la langue du texte de revue de Grok. La sortie propre à Grok et les détails d'erreur provenant du système d'exploitation ou de Grok ne sont pas traduits.

## Dépannage

Si une invocation signale une erreur HTTP 402 avec `usage balance exhausted`, le solde d'utilisation de Grok Build est épuisé. Réessayez une fois ce solde rétabli. La génération d'images par abonnement utilise ce même quota partagé. Si la génération indique que les outils d'image de Grok Build nécessitent un abonnement SuperGrok, cette connexion n'inclut pas Imagine ; utilisez une offre qui l'inclut, ou une clé d'API avec `--allow-api-billing`. Un délai d'attente dépassé, un refus de permission, une revue incomplète ou un arrêt non confirmé de l'agent constituent une invocation en échec ; ne considérez pas une sortie partielle comme une revue ou une tâche terminée.

Pour choisir le modèle d'image de `/grok:imagine`, passez `--image-model <id>` (ou définissez `GROK_PLUGIN_IMAGE_MODEL`). Pour modifier une image existante, utilisez `--image-edit-model <id>` (ou `GROK_PLUGIN_IMAGE_EDIT_MODEL`) ; l'ID de génération n'est jamais réutilisé pour les modifications. Le companion définit `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE` de Grok pour cette exécution seulement et indique les ID demandés dans `requestedImageModel` avec `--json`. Sans ces options, la valeur par défaut est `grok-imagine-image-2.0` (qualité maximale, également utilisée pour les modifications), sauf si vous définissez vous-même `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`, transmis à Grok tel quel. Passez `auto` (insensible à la casse) à l'une des options ou variables `GROK_PLUGIN_IMAGE_*` pour laisser Grok choisir : le plugin ne définit rien, un override défini par vous reste transmis, sinon `requestedImageModel` vaut `null`. Les ID ne sont vérifiés que par leurs caractères ; un ID que votre compte ne peut pas utiliser est rejeté par xAI lors de la génération. `--effort` règle la profondeur de raisonnement du modèle de chat, pas la qualité de l'image.

Pendant les revues et les tâches en lecture seule (`task` sans `--write`), les wrappers Python, Node.js, Bun et shell sont refusés, même pour des scripts destinés uniquement à lire des fichiers. Grok Build peut mettre fin au tour avec `cancelled` après un rejet de permission. Utilisez les outils de fichiers intégrés pour inspecter le JSON et les autres éléments de preuve ; les preuves indisponibles restent non vérifiées. Le prompt de revue, ainsi que les consignes ajoutées après votre demande dans une tâche en lecture seule, fournissent ces restrictions avant le début de l'inspection.

Pour les builds depuis les sources, les commandes de développement et la validation, voir [Développement](CONTRIBUTING.md#english). La structure d'exécution et ses limites sont décrites dans [DESIGN.md](DESIGN.md).
