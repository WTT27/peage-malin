# Péage Malin

Application web (téléphone ou PC) qui cherche les **bons compromis entre péages, énergie et temps de trajet**
en France, puis ouvre l'itinéraire choisi dans Google Maps.

- Coût de chaque itinéraire : péages (tarifs officiels classe 1) + gazole ou électricité.
- Recherche des itinéraires « intermédiaires » : sortir avant une barrière, reprendre après, finir par une
  nationale (ex. N10), etc. Seuls les itinéraires **efficaces** sont montrés (aucun autre n'est à la fois plus
  rapide et moins cher), avec le **meilleur compromis**, les **gains gratuits** et un curseur « temps accepté ».
- Tout fonctionne dans le navigateur. Services gratuits : TomTom (clé personnelle gratuite, à saisir dans les
  réglages, jamais publiée), Valhalla et OpenStreetMap, data.gouv.fr.

Application : https://wtt27.github.io/peage-malin/

Sources des tarifs : grilles officielles des sociétés d'autoroutes (SAPN, Sanef, APRR, AREA, Cofiroute, Vinci),
gares de péage (data.gouv.fr), sorties d'autoroute © contributeurs OpenStreetMap (ODbL).
Détails du projet : [docs/](docs/).
