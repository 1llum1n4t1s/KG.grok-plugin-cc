[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Grok-Plugin für Claude Code und Codex

Führen Sie Grok Build aus Claude Code oder Codex heraus aus, um Code-Reviews, Repository-Audits, X-Suchen, delegierte Aufgaben und Bilderzeugung durchzuführen. Dieses Projekt ist ein Fork von [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc); siehe [NOTICE](NOTICE).

## Voraussetzungen und Installation

Installieren Sie [Grok Build](https://x.ai/cli), melden Sie sich an oder konfigurieren Sie den zugehörigen API-Schlüssel, und installieren Sie Git 2.45 oder neuer (oder einen Git-Build mit rückportiertem `--no-lazy-fetch`). Installieren Sie unter Windows, macOS und Linux Bun 1.4.4 oder neuer oder Node.js 22 oder neuer; Bun wird bevorzugt, wenn beide verfügbar sind. Die Nutzung von Grok wird dem verwendeten Konto bzw. API-Schlüssel berechnet. Grok muss `grok agent stdio` unterstützen; aktualisieren Sie es bei Bedarf mit `grok update`.

Unter Windows enthält das Plugin native Helfer für die Laufzeiten ia32, x64 und arm64. Eine Installation von Rust oder MSVC ist nicht erforderlich.

In Claude Code:

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Führen Sie für Codex Folgendes aus:

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

Starten Sie eine neue Codex-Aufgabe, um die zugehörigen Skills zu laden. Wenn Sie beide Hosts verwenden, installieren Sie das Plugin in jedem separat.

### Updates

Claude Code schaltet die automatische Aktualisierung für Marketplaces von Drittanbietern wie `kagayoi-grok` standardmäßig aus. Um sie zu aktivieren, führen Sie in einer Claude-Code-Sitzung `/plugin` aus, öffnen Sie den Tab **Marketplaces**, wählen Sie `kagayoi-grok` und klicken Sie auf **Enable auto-update**. Claude Code aktualisiert den Marketplace danach nach dem Start einer Sitzung und aktualisiert das installierte Plugin; führen Sie `/reload-plugins` aus oder starten Sie eine neue Sitzung, um die neue Version zu laden. Um sofort zu aktualisieren, führen Sie stattdessen `claude plugin update grok@kagayoi-grok` in Ihrer Shell aus.

Führen Sie für Codex `codex plugin marketplace upgrade kagayoi-grok` aus, um den Marketplace zu aktualisieren, und starten Sie anschließend eine neue Codex-Aufgabe.

## Befehle

Claude Code stellt `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, `/grok:imagine`, `/grok:rescue`, `/grok:x` und `/grok:setup` bereit. In Codex wählen Sie den entsprechenden Skill `grok:source-command-<name>`. Review und Audit sind schreibgeschützt; Rescue kann Änderungen anfordern, während die X-Suche schreibgeschützt bleibt. `/grok:imagine <description>` lässt Grok Build ein Bild erzeugen und kopiert es nach `grok-imagine/` im Workspace oder nach `--output <path>`, wenn dieser Pfad im Workspace bleibt. Das übrige Repository wird nicht bearbeitet. Mit `grok login` wird die Erzeugung aus dem gemeinsamen wöchentlichen Nutzungsguthaben des Abonnements gezogen. Ist `XAI_API_KEY` gesetzt, stoppt der Befehl, bis `--allow-api-billing` übergeben wird: API-Bilder werden zu xAI-Preisen abgerechnet (`grok-imagine-image-2.0` ist ab $0.04/img gelistet), nicht aus diesem Guthaben. Setup prüft die Grok-Authentifizierung.

Verwenden Sie unter Windows `/grok:review --scope working-tree`, um lokale Änderungen zu prüfen. Die Scopes `auto` und `working-tree` erfordern einen vollständigen, sicheren Windows-Snapshot und schlagen fehl, wenn dieser nicht erstellt werden kann. Verwenden Sie unter macOS/Linux ausdrücklich `/grok:review --scope branch` oder `--base <ref>`, um committete Änderungen zu prüfen; nicht committete Änderungen sind vom Vergleichs-Diff ausgeschlossen, umgebende Dateien können jedoch weiterhin aus dem Arbeitsverzeichnis gelesen werden. Verwenden Sie `/grok:audit authentication`, um ein Audit des gesamten Repositorys auf jeder Plattform auf ein Thema zu fokussieren, oder `/grok:rescue <task>`, um eine Aufgabe zu delegieren. Review, Adversarial Review und Audit akzeptieren außerdem `--language <BCP 47 tag>`. Führen Sie `/grok:setup` aus, wenn Installation oder Authentifizierung fehlschlägt; folgen Sie der gemeldeten Fehlermeldung und der Anmeldeanleitung von Grok.

Jeder Aufruf startet eine neue Grok-Sitzung im Vordergrund und gibt das Ergebnis direkt zurück. Verwenden Sie die eigene Oberfläche von Grok, um eine Unterhaltung fortzusetzen. Automatische Reviews sowie die früheren Befehle status, result, cancel, state-lock und task-resume werden vom Companion nicht mehr unterstützt.

Der Companion startet die lokal installierte Grok-CLI. Er prüft Pfade bei ACP-Dateianfragen und wendet eine schreibgeschützte Berechtigungs-Allowlist an; ausdrücklich angeforderte Schreibaufgaben können den Workspace verändern. Grok Build übernimmt seine integrierten Dateisystem- und Shell-Operationen, den externen Zugriff und die Authentifizierung. Der Companion vermittelt nicht jede E/A-Operation, bietet keine OS-Sandbox und garantiert keine vollständige Zugriffsisolierung, auch nicht über Symlinks. Prüfen Sie die Ausgabe und die Änderungen von Grok, bevor Sie sich darauf verlassen.

## Anzeigesprache

Die eigenen Meldungen des Companions (Setup-Ergebnisse, Review-Überschriften, Diagnosen und Hilfe) werden in der Sprache Ihrer Umgebung angezeigt. Er prüft `GROK_PLUGIN_LANGUAGE`, dann `LC_ALL`, `LC_MESSAGES` und `LANG`, danach die Anzeigesprache des Systems und greift auf Englisch zurück. Unterstützte Sprachen sind `ja`, `en`, `zh-CN`, `zh-TW`, `ko`, `es`, `fr`, `de` und `pt-BR`. Dies ist unabhängig von `--language`, das die Sprache des Review-Textes von Grok festlegt. Die eigene Ausgabe von Grok sowie Fehlerdetails des Betriebssystems oder von Grok werden nicht übersetzt.

## Fehlerbehebung

Meldet ein Aufruf HTTP 402 mit `usage balance exhausted`, ist das Nutzungsguthaben von Grok Build aufgebraucht. Versuchen Sie es erneut, sobald sich das Guthaben erholt hat. Die Bilderzeugung per Abonnement nutzt dasselbe gemeinsame Guthaben. Meldet die Bilderzeugung, dass die Bildwerkzeuge von Grok Build ein SuperGrok-Abonnement benötigen, enthält diese Anmeldung Imagine nicht; verwenden Sie einen Tarif, der es enthält, oder einen API-Schlüssel mit `--allow-api-billing`. Ein Timeout, eine verweigerte Berechtigung, ein unvollständiges Review oder ein nicht bestätigter Agent-Stopp gilt als fehlgeschlagener Aufruf; behandeln Sie Teilausgaben nicht als abgeschlossenes Review oder abgeschlossene Aufgabe.

Bei schreibgeschützten Reviews und Tasks (`task` ohne `--write`) werden Python-, Node.js-, Bun- und Shell-Wrapper selbst dann verweigert, wenn die Skripte nur Dateien lesen sollen. Grok Build kann den Turn nach einer Berechtigungsablehnung mit `cancelled` beenden. Verwenden Sie die integrierten Dateiwerkzeuge, um JSON und andere Belege zu prüfen; nicht verfügbare Belege bleiben unverifiziert. Der Review-Prompt und die Hinweise, die ein schreibgeschützter Task hinter Ihre Anfrage anhängt, nennen diese Einschränkungen, bevor die Prüfung beginnt.

Informationen zu Source-Builds, Entwicklungsbefehlen und Validierung finden Sie unter [Entwicklung](CONTRIBUTING.md#english). Laufzeitstruktur und Grenzen sind in [DESIGN.md](DESIGN.md) beschrieben.
