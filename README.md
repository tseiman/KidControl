# KidControl

KidControl soll den Netzwerkzugriff kabelgebundener Apple TVs über die offizielle UniFi Network API und vorhandene ACL-Regeln zeitgesteuert freigeben. Benutzer starten und stoppen ihre Nutzung über eine für Smartphones optimierte WebUI; tägliche Zeitbudgets werden geräteübergreifend abgerechnet.

## Status

Planungsphase – Anforderungen und Architektur sind dokumentiert, die Laufzeit und konkrete Implementierung werden vor dem Coding festgelegt.

## Geplante Voraussetzungen

- Debian 12 oder 13
- Zugriff auf eine UniFi Console mit Network Integration API und API-Key
- pro Apple TV eine getestete UniFi-ACL-Regel
- Node.js als bevorzugte Web-/Server-Laufzeit; genaue Version und SQLite-Anbindung noch offen
- optional Python mit `pyatv` zur Erkennung des Apple-TV-Ruhezustands

## Dokumentation

- [Anforderungen, Architektur und offene Entscheidungen](docs/README_KIDCONTROL.md)
- [Platzhalter für die spätere Implementierung](code/README_CODE.md)

Die WebUI soll dieselbe Markdown-Datei aus `docs/` als HTML anzeigen. Ein relativer Symlink unter `code/public/docs/` verhindert eine fehleranfällige zweite Kopie.

## Sicherheit

UniFi-API-Keys gehören nicht ins Repository. Die Anwendung soll den Schlüssel später ausschließlich aus einer geschützten Laufzeitkonfiguration bzw. Umgebungsvariable lesen.

## Lizenz

[MIT](LICENSE)
