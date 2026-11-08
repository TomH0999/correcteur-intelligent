'use strict';
/**
 * Corpus de code CORRECT (tel qu'écrit en cours de BUT Informatique) qui doit s'exécuter sans
 * « fausse erreur » due à l'outil. Chaque cas : langage, code, entrée éventuelle, sortie attendue (regex).
 */
const SCHEMA_ORACLE = `
CREATE TABLE client (
  id_client NUMBER(5) CONSTRAINT pk_client PRIMARY KEY,
  nom VARCHAR2(30) NOT NULL,
  ville VARCHAR2(30),
  date_naiss DATE,
  solde NUMBER(8,2) DEFAULT 0 CHECK (solde >= 0)
);
CREATE TABLE commande (
  id_cmd NUMBER(5),
  id_client NUMBER(5),
  montant NUMBER(8,2),
  date_cmd DATE,
  CONSTRAINT pk_cmd PRIMARY KEY (id_cmd),
  CONSTRAINT fk_cmd_client FOREIGN KEY (id_client) REFERENCES client(id_client) ON DELETE CASCADE
);
INSERT INTO client VALUES (1, 'Ada', 'Lyon', TO_DATE('10/12/2004', 'DD/MM/YYYY'), 120.5);
INSERT INTO client VALUES (2, 'Linus', 'Paris', TO_DATE('28/12/2003', 'DD/MM/YYYY'), 0);
INSERT INTO client VALUES (3, 'Grace', 'Lyon', NULL, 40);
INSERT INTO commande VALUES (10, 1, 99.90, SYSDATE);
INSERT INTO commande VALUES (11, 1, 15, SYSDATE);
INSERT INTO commande VALUES (12, 2, 250, SYSDATE);
COMMIT;
`;

module.exports = [
  // ----------------------------------------------------------------- SQL Oracle (R1.05 / R2.06)
  { lang: 'sql', name: 'Oracle MINUS', code: `${SCHEMA_ORACLE}\nSELECT nom FROM client\nMINUS\nSELECT c.nom FROM client c JOIN commande o ON o.id_client = c.id_client;`, expect: /Grace/ },
  { lang: 'sql', name: 'Oracle NVL / NVL2', code: `${SCHEMA_ORACLE}\nSELECT nom, NVL(TO_CHAR(date_naiss, 'YYYY'), 'inconnue') AS annee, NVL2(date_naiss, 'oui', 'non') AS connue FROM client ORDER BY nom;`, expect: /inconnue/ },
  { lang: 'sql', name: 'Oracle DECODE', code: `${SCHEMA_ORACLE}\nSELECT nom, DECODE(ville, 'Lyon', 'L', 'Paris', 'P', '?') AS code FROM client ORDER BY id_client;`, expect: /Ada.*L/s },
  { lang: 'sql', name: 'Oracle DUAL + SYSDATE', code: 'SELECT SYSDATE FROM DUAL;\nSELECT 1 + 1 AS deux FROM dual;', expect: /2/ },
  { lang: 'sql', name: 'Oracle ROWNUM', code: `${SCHEMA_ORACLE}\nSELECT nom FROM client WHERE ROWNUM <= 2;`, expect: /Ada/ },
  { lang: 'sql', name: 'Oracle séquence NEXTVAL', code: `${SCHEMA_ORACLE}\nCREATE SEQUENCE seq_cmd START WITH 100 INCREMENT BY 1;\nINSERT INTO commande VALUES (seq_cmd.NEXTVAL, 3, 12, SYSDATE);\nSELECT id_cmd FROM commande WHERE id_client = 3;`, expect: /100/ },
  { lang: 'sql', name: 'Oracle ALTER TABLE ADD CONSTRAINT', code: `${SCHEMA_ORACLE}\nALTER TABLE client ADD CONSTRAINT ck_ville CHECK (ville IS NOT NULL);\nALTER TABLE client MODIFY (nom VARCHAR2(50));\nSELECT COUNT(*) AS n FROM client;`, expect: /3/ },
  { lang: 'sql', name: 'Oracle division décimale', code: 'SELECT 5/2 AS d FROM DUAL;', expect: /2[.,]5/ },
  { lang: 'sql', name: 'Oracle ADD_MONTHS / MONTHS_BETWEEN / TRUNC', code: "SELECT ADD_MONTHS(TO_DATE('31/01/2024','DD/MM/YYYY'), 1) AS d, TRUNC(MONTHS_BETWEEN(TO_DATE('01/06/2024','DD/MM/YYYY'), TO_DATE('01/01/2024','DD/MM/YYYY'))) AS m FROM DUAL;", expect: /5/ },
  { lang: 'sql', name: 'Oracle FETCH FIRST + sous-requête', code: `${SCHEMA_ORACLE}\nSELECT nom, solde FROM client WHERE solde > (SELECT AVG(solde) FROM client) ORDER BY solde DESC FETCH FIRST 1 ROWS ONLY;`, expect: /Ada/ },
  { lang: 'sql', name: 'Oracle GROUP BY HAVING + jointure', code: `${SCHEMA_ORACLE}\nSELECT c.nom, COUNT(o.id_cmd) AS nb, SUM(o.montant) AS total FROM client c LEFT JOIN commande o ON c.id_client = o.id_client GROUP BY c.nom HAVING COUNT(o.id_cmd) >= 1 ORDER BY total DESC;`, expect: /Linus/ },
  { lang: 'sql', name: 'Oracle jointure externe (+)', code: `${SCHEMA_ORACLE}\nSELECT c.nom, o.id_cmd FROM client c, commande o WHERE c.id_client = o.id_client(+) ORDER BY c.nom;`, expect: /Grace/ },
  { lang: 'sql', name: 'Oracle script SQL*Plus (SET, PROMPT, /, REM, COMMENT)', code: `SET SERVEROUTPUT ON\nSET LINESIZE 200\nREM Création\nPROMPT Création des tables\n${SCHEMA_ORACLE}\nCOMMENT ON TABLE client IS 'Les clients';\n/\nSELECT COUNT(*) AS n FROM client;`, expect: /3/ },
  { lang: 'sql', name: 'Oracle vue CREATE OR REPLACE', code: `${SCHEMA_ORACLE}\nCREATE OR REPLACE VIEW v_lyon AS SELECT * FROM client WHERE ville = 'Lyon';\nSELECT COUNT(*) AS n FROM v_lyon;`, expect: /2/ },
  { lang: 'sql', name: 'Oracle INITCAP / LPAD / SUBSTR / INSTR / CONCAT', code: "SELECT INITCAP('jean dupont') AS a, LPAD('7', 3, '0') AS b, SUBSTR('Bonjour', 1, 3) AS c, INSTR('Bonjour', 'j') AS d, CONCAT('a', 'b') AS e FROM DUAL;", expect: /Jean Dupont/ },
  { lang: 'sql', name: 'Oracle bloc PL/SQL anonyme', code: "SET SERVEROUTPUT ON\nBEGIN\n  DBMS_OUTPUT.PUT_LINE('Bonjour');\nEND;\n/", expect: /Bonjour/ },
  { lang: 'sql', name: 'Oracle DROP TABLE CASCADE CONSTRAINTS', code: `${SCHEMA_ORACLE}\nDROP TABLE commande CASCADE CONSTRAINTS;\nSELECT COUNT(*) AS n FROM client;`, expect: /3/ },
  // ----------------------------------------------------------------- SQL MySQL / PostgreSQL / SQL standard
  { lang: 'sql', name: 'MySQL AUTO_INCREMENT + ENGINE + backticks', code: "CREATE TABLE `etudiant` (`id` INT(11) NOT NULL AUTO_INCREMENT, `nom` VARCHAR(50), `actif` TINYINT(1) DEFAULT 1, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\nINSERT INTO `etudiant` (`nom`) VALUES ('Tom'), ('Lea');\nSELECT * FROM `etudiant` LIMIT 0, 10;", expect: /Lea/ },
  { lang: 'sql', name: 'MySQL IFNULL / NOW / DATE_FORMAT', code: "SELECT IFNULL(NULL, 'x') AS a, YEAR(NOW()) > 2000 AS b, DATE_FORMAT('2024-03-05', '%d/%m/%Y') AS c;", expect: /05\/03\/2024/ },
  { lang: 'sql', name: 'PostgreSQL SERIAL / :: / ILIKE', code: "CREATE TABLE t (id SERIAL PRIMARY KEY, nom TEXT);\nINSERT INTO t (nom) VALUES ('Alice'), ('bob');\nSELECT nom, id::text AS i FROM t WHERE nom ILIKE 'b%';", expect: /bob/ },
  { lang: 'sql', name: 'SQL standard EXCEPT / INTERSECT / CTE / fenêtre', code: "CREATE TABLE n (v INT);\nINSERT INTO n VALUES (1),(2),(3),(4);\nWITH p AS (SELECT v FROM n WHERE MOD(v, 2) = 0) SELECT v, RANK() OVER (ORDER BY v DESC) AS r FROM p;\nSELECT v FROM n EXCEPT SELECT v FROM n WHERE v > 2 ORDER BY v;", expect: /4/ },
  { lang: 'sql', name: 'SQL Server TOP / GETDATE', code: "CREATE TABLE p (nom VARCHAR(10), prix INT);\nINSERT INTO p VALUES ('a', 3), ('b', 9);\nSELECT TOP 1 nom FROM p ORDER BY prix DESC;\nSELECT GETDATE() AS d;", expect: /b/ },
  { lang: 'sql', name: 'Erreur réelle de l\'étudiant (doit rester une erreur)', code: 'CREATE TABLE x (a INT);\nSELECT b FROM x;', expectError: true },
  // ----------------------------------------------------------------- Python
  { lang: 'python', name: 'Python input() multiples', code: 'a = int(input("A ? "))\nb = int(input("B ? "))\nprint(a + b)', stdin: '2\n3', expect: /5/ },
  { lang: 'python', name: 'Python input() sans entrée fournie', code: 'nom = input("Nom ? ")\nprint("Bonjour", nom)', expect: /Bonjour/, allowInternal: true },
  { lang: 'python', name: 'Python lecture de fichier fourni', code: "with open('notes.txt') as f:\n    print(sum(int(l) for l in f))", files: { 'notes.txt': '12\n15\n' }, expect: /27/ },
  { lang: 'python', name: 'Python module standard (math, random, datetime, collections)', code: 'import math, random, datetime\nfrom collections import Counter\nprint(math.gcd(12, 18), Counter("abca")["a"])', expect: /6 2/ },
  { lang: 'python', name: 'Python numpy', code: 'import numpy as np\nprint(np.array([1, 2, 3]).sum())', expect: /6/, network: true, allowInternal: true },
  { lang: 'python', name: 'Python if __name__ == "__main__"', code: 'def main():\n    print("ok main")\n\nif __name__ == "__main__":\n    main()', expect: /ok main/ },
  { lang: 'python', name: 'Python time.sleep court', code: 'import time\ntime.sleep(0.2)\nprint("fini")', expect: /fini/ },
  { lang: 'python', name: 'Python erreur réelle (doit rester une erreur)', code: 'print(1/0)', expectError: true },
  // ----------------------------------------------------------------- JavaScript / TypeScript
  { lang: 'javascript', name: 'JS require + module.exports', code: "const fs = require('fs');\nconst path = require('path');\nfunction somme(t) { return t.reduce((a, b) => a + b, 0); }\nmodule.exports = { somme };\nconsole.log(somme([1, 2, 3]), typeof fs.readFileSync, path.basename('/a/b.txt'));", expect: /6 function b\.txt/ },
  { lang: 'javascript', name: 'JS async / await / setTimeout', code: 'const attendre = (ms) => new Promise((r) => setTimeout(r, ms));\n(async () => { await attendre(50); console.log("après attente"); })();', expect: /après attente/ },
  { lang: 'javascript', name: 'JS await au niveau supérieur (ESM)', code: 'import { setTimeout as sleep } from "node:timers/promises";\nawait sleep(10);\nconsole.log("esm ok");', expect: /esm ok/ },
  { lang: 'javascript', name: 'JS classes + Map + JSON', code: 'class Pile { #t = []; empiler(x) { this.#t.push(x); } get taille() { return this.#t.length; } }\nconst p = new Pile(); p.empiler(1); p.empiler(2);\nconsole.log(p.taille, JSON.stringify(new Map([[1, 2]]).size));', expect: /2 1/ },
  { lang: 'javascript', name: 'JS lecture stdin (readline)', code: "const rl = require('readline').createInterface({ input: process.stdin });\nconst l = [];\nrl.on('line', (x) => l.push(Number(x)));\nrl.on('close', () => console.log(l.reduce((a, b) => a + b, 0)));", stdin: '4\n5\n', expect: /9/ },
  { lang: 'typescript', name: 'TypeScript typé', code: 'interface Point { x: number; y: number }\nconst dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);\nconsole.log(dist({ x: 0, y: 0 }, { x: 3, y: 4 }));', expect: /5/ },
  // ----------------------------------------------------------------- Java
  { lang: 'java', name: 'Java avec package + Scanner', code: 'package fr.iut.tp1;\n\nimport java.util.Scanner;\n\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    int a = sc.nextInt();\n    int b = sc.nextInt();\n    System.out.println("Somme : " + (a + b));\n  }\n}', stdin: '4 5', expect: /Somme : 9/, needs: 'java' },
  { lang: 'java', name: 'Java accents et plusieurs classes', code: 'class Etudiant {\n  String nom;\n  Etudiant(String n) { nom = n; }\n}\npublic class Ecole {\n  public static void main(String[] a) {\n    System.out.println("Élève : " + new Etudiant("Léa").nom);\n  }\n}', expect: /Élève : Léa/, needs: 'java' },
  { lang: 'java', name: 'Java Scanner sans entrée fournie', code: 'import java.util.Scanner;\npublic class Main {\n  public static void main(String[] a) {\n    Scanner sc = new Scanner(System.in);\n    System.out.print("Nombre ? ");\n    int n = sc.nextInt();\n    System.out.println(n * 2);\n  }\n}', expect: /Nombre/, needs: 'java', allowInternal: true },
  // ----------------------------------------------------------------- C
  { lang: 'c', name: 'C scanf + math.h', code: '#include <stdio.h>\n#include <math.h>\nint main(void) {\n  double x;\n  scanf("%lf", &x);\n  printf("%.1f\\n", sqrt(x));\n  return 0;\n}', stdin: '16', expect: /4\.0/, needs: 'gcc' },
  { lang: 'c', name: 'C system("pause") (Windows)', code: '#include <stdio.h>\n#include <stdlib.h>\nint main() {\n  printf("ok\\n");\n  system("pause");\n  return 0;\n}', expect: /ok/, needs: 'gcc' },
  // ----------------------------------------------------------------- Série 2 : cas plus piégeux
  { lang: 'sql', name: 'Oracle PL/SQL : SELECT INTO + variable', code: `${SCHEMA_ORACLE}\nSET SERVEROUTPUT ON\nDECLARE\n  v_nb NUMBER := 0;\nBEGIN\n  SELECT COUNT(*) INTO v_nb FROM client;\n  DBMS_OUTPUT.PUT_LINE('Nombre de clients : ' || v_nb);\nEND;\n/`, expect: /Nombre de clients : 3/ },
  { lang: 'sql', name: 'Oracle PL/SQL : curseur FOR … IN (SELECT)', code: `${SCHEMA_ORACLE}\nBEGIN\n  FOR r IN (SELECT nom FROM client ORDER BY nom) LOOP\n    DBMS_OUTPUT.PUT_LINE(r.nom);\n  END LOOP;\nEND;\n/`, expect: /Ada[\s\S]*Grace[\s\S]*Linus/ },
  { lang: 'sql', name: 'Oracle procédure + EXEC', code: `${SCHEMA_ORACLE}\nCREATE OR REPLACE PROCEDURE crediter(p_id IN NUMBER, p_montant IN NUMBER) IS\nBEGIN\n  UPDATE client SET solde = solde + p_montant WHERE id_client = p_id;\nEND crediter;\n/\nEXEC crediter(2, 30);\nSELECT solde FROM client WHERE id_client = 2;`, expect: /30/ },
  { lang: 'sql', name: 'Oracle fonction utilisée dans un SELECT', code: `${SCHEMA_ORACLE}\nCREATE OR REPLACE FUNCTION nb_cmd(p_id NUMBER) RETURN NUMBER IS\n  v NUMBER;\nBEGIN\n  SELECT COUNT(*) INTO v FROM commande WHERE id_client = p_id;\n  RETURN v;\nEND;\n/\nSELECT nom, nb_cmd(id_client) AS n FROM client ORDER BY id_client;`, expect: /Ada \| 2/ },
  { lang: 'sql', name: 'Oracle déclencheur BEFORE INSERT :NEW', code: `${SCHEMA_ORACLE}\nCREATE OR REPLACE TRIGGER trg_nom BEFORE INSERT ON client FOR EACH ROW\nBEGIN\n  :NEW.nom := UPPER(:NEW.nom);\nEND;\n/\nINSERT INTO client (id_client, nom, ville) VALUES (4, 'ken', 'Nice');\nSELECT nom FROM client WHERE id_client = 4;`, expect: /KEN/ },
  { lang: 'sql', name: 'Oracle dates au format français DD/MM/YYYY', code: `${SCHEMA_ORACLE}\nSELECT nom FROM client WHERE date_naiss < '01/01/2004';`, expect: /Linus/ },
  { lang: 'sql', name: 'Oracle sous-requête + ROWNUM (top-N)', code: `${SCHEMA_ORACLE}\nSELECT * FROM (SELECT nom, solde FROM client ORDER BY solde DESC) WHERE ROWNUM <= 1;`, expect: /Ada/ },
  { lang: 'sql', name: 'Oracle CREATE TABLE AS SELECT', code: `${SCHEMA_ORACLE}\nCREATE TABLE client_lyon AS SELECT * FROM client WHERE ville = 'Lyon';\nSELECT COUNT(*) AS n FROM client_lyon;`, expect: /2/ },
  { lang: 'sql', name: 'Oracle INSERT ALL', code: "CREATE TABLE t (a NUMBER, b VARCHAR2(5));\nINSERT ALL\n  INTO t VALUES (1, 'x')\n  INTO t VALUES (2, 'y')\nSELECT * FROM dual;\nSELECT COUNT(*) AS n FROM t;", expect: /2/ },
  { lang: 'sql', name: 'Oracle TO_CHAR nombre / EXTRACT / CASE', code: `${SCHEMA_ORACLE}\nSELECT nom, TO_CHAR(solde, '999.99') AS s, EXTRACT(YEAR FROM date_naiss) AS an, CASE WHEN solde > 50 THEN 'riche' ELSE 'modeste' END AS cat FROM client ORDER BY id_client;`, expect: /riche/ },
  { lang: 'sql', name: 'Oracle CONNECT BY (non convertible -> limite de l\'outil)', code: "CREATE TABLE emp (id NUMBER, chef NUMBER, nom VARCHAR2(10));\nINSERT INTO emp VALUES (1, NULL, 'A');\nINSERT INTO emp VALUES (2, 1, 'B');\nSELECT nom, LEVEL FROM emp START WITH chef IS NULL CONNECT BY PRIOR id = chef;", expect: /B/, allowInternal: true },
  { lang: 'sql', name: 'Oracle LISTAGG', code: `${SCHEMA_ORACLE}\nSELECT ville, LISTAGG(nom, ', ') WITHIN GROUP (ORDER BY nom) AS noms FROM client GROUP BY ville ORDER BY ville;`, expect: /Ada, Grace/ },
  { lang: 'sql', name: 'MySQL GROUP_CONCAT + DESCRIBE + USE', code: "CREATE DATABASE tp;\nUSE tp;\nCREATE TABLE e (nom VARCHAR(10), grp INT);\nDESCRIBE e;\nINSERT INTO e VALUES ('a', 1), ('b', 1);\nSELECT grp, GROUP_CONCAT(nom ORDER BY nom SEPARATOR '-') AS l FROM e GROUP BY grp;", expect: /a-b/ },
  { lang: 'sql', name: 'MySQL ON DUPLICATE KEY (non convertible -> limite)', code: "CREATE TABLE k (id INT PRIMARY KEY, n INT);\nINSERT INTO k VALUES (1, 1);\nINSERT INTO k VALUES (1, 5) ON DUPLICATE KEY UPDATE n = n + 1;\nSELECT n FROM k;", expect: /2/, allowInternal: true },
  { lang: 'python', name: 'Python sys.exit(0)', code: 'import sys\nprint("avant")\nsys.exit(0)', expect: /avant/ },
  { lang: 'python', name: 'Python exit() à la fin', code: 'print("fin")\nexit()', expect: /fin/ },
  { lang: 'python', name: 'Python récursion (900 niveaux, sous la limite CPython de 1000)', code: 'def f(n):\n    return 0 if n == 0 else 1 + f(n - 1)\nprint(f(900))', expect: /900/ },
  { lang: 'python', name: 'Python turtle (graphique -> limite)', code: 'import turtle\nt = turtle.Turtle()\nt.forward(10)', expect: /.^/, allowInternal: true },
  { lang: 'javascript', name: 'JS prompt() de navigateur (-> limite)', code: 'const n = Number(prompt("Nombre ?"));\nconsole.log(n * 2);', expect: /.^/, allowInternal: true },
  { lang: 'javascript', name: 'JS process.argv / process.exit', code: 'console.log("ok", process.argv.length > 1);\nprocess.exit(0);', expect: /ok true/ },
  { lang: 'java', name: 'Java classe Main non publique + méthodes static', code: 'import java.util.*;\nclass Main {\n  static int carre(int x) { return x * x; }\n  public static void main(String[] args) {\n    List<Integer> l = new ArrayList<>(List.of(3, 1, 2));\n    Collections.sort(l);\n    System.out.println(l + " " + carre(4));\n  }\n}', expect: /\[1, 2, 3\] 16/, needs: 'java' },
  { lang: 'cpp', name: 'C++ iostream + vector + cin', code: '#include <iostream>\n#include <vector>\nusing namespace std;\nint main() {\n  int n; cin >> n;\n  vector<int> v(n, 2);\n  int s = 0; for (int x : v) s += x;\n  cout << "Somme = " << s << endl;\n}', stdin: '3', expect: /Somme = 6/, needs: 'g++' },
  { lang: 'c', name: 'C conio.h getch (Windows -> limite)', code: '#include <stdio.h>\n#include <conio.h>\nint main() { printf("ok\\n"); getch(); return 0; }', expect: /ok/, needs: 'gcc', allowInternal: true }
];
