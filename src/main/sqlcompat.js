'use strict';
/**
 * Compatibilité SQL : le code des étudiants est écrit pour Oracle (le plus courant en BUT), MySQL,
 * PostgreSQL ou SQL Server. Il est exécuté sur un vrai PostgreSQL embarqué (PGlite) ; ce module
 *  - découpe un script en instructions (en gérant chaînes, commentaires, blocs PL/SQL et « / ») ;
 *  - ignore les commandes de l'outil SQL*Plus / client (SET, PROMPT, REM, SPOOL, DESC…) ;
 *  - traduit les syntaxes propres à chaque SGBD (MINUS, NVL, DECODE, ROWNUM, séquences, AUTO_INCREMENT, TOP…) ;
 *  - convertit les blocs PL/SQL simples (anonymes, procédures, fonctions, déclencheurs) en PL/pgSQL.
 * Les syntaxes valides d'un SGBD ne doivent jamais être comptées comme des erreurs de l'étudiant.
 */

// ---------------------------------------------------------------- Outils de parcours

/** Applique fn aux portions de code situées HORS chaînes, identifiants entre guillemets et commentaires. */
function mapCode(sql, fn) {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out += fn(buf);
    buf = '';
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) break;
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && n === '-') {
      flush();
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '/' && n === '*') {
      flush();
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '$' && /^\$[a-z_]*\$/i.test(sql.slice(i, i + 40))) {
      // chaîne PostgreSQL $tag$ … $tag$
      flush();
      const tag = sql.slice(i).match(/^\$[a-z_]*\$/i)[0];
      const j = sql.indexOf(tag, i + tag.length);
      const end = j < 0 ? sql.length : j + tag.length;
      out += sql.slice(i, end);
      i = end;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}

/** Remplace les backticks MySQL par des guillemets doubles (identifiants). */
function backticksToQuotes(sql) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inStr) inStr = true;
    else if (c === "'" && inStr) inStr = sql[i + 1] === "'" ? (out += c, i++, true) : false;
    out += !inStr && c === '`' ? '"' : c;
  }
  return out;
}

/** Arguments d'un appel de fonction à partir de la parenthèse ouvrante (index). Renvoie { args, end }. */
function callArgs(s, open) {
  let depth = 0;
  let cur = '';
  const args = [];
  let inStr = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; cur += c; continue; }
    if (c === '(') { depth++; if (depth === 1) continue; }
    if (c === ')') {
      depth--;
      if (depth === 0) { args.push(cur.trim()); return { args, end: i }; }
    }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return null;
}

/** Remplace chaque appel NOM(...) par build(args). */
function replaceCalls(sql, name, build) {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'gi');
  let out = sql;
  let guard = 0;
  let m;
  while ((m = re.exec(out)) && guard++ < 500) {
    const open = out.indexOf('(', m.index);
    const r = callArgs(out, open);
    if (!r) break;
    const rep = build(r.args);
    if (rep == null) continue;
    out = out.slice(0, m.index) + rep + out.slice(r.end + 1);
    re.lastIndex = m.index + rep.length;
  }
  return out;
}

// ---------------------------------------------------------------- Découpage en instructions

const CLIENT_CMD = /^\s*(SET\s+(SERVEROUTPUT|ECHO|LINESIZE|LINES|PAGESIZE|PAGES|FEEDBACK|HEADING|VERIFY|TIMING|TERMOUT|AUTOCOMMIT|DEFINE|SQLBLANKLINES|COLSEP|TRIMSPOOL|NULL|NUMWIDTH|LONG|WRAP|TAB|AUTOTRACE|SQLPROMPT|SERVEROUT)\b|PROMPT\b|REM\b|REMARK\b|SPOOL\b|CONNECT\b|CONN\b|DISCONNECT\b|DEFINE\b|UNDEFINE\b|ACCEPT\b|COLUMN\b|COL\s|TTITLE\b|BTITLE\b|BREAK\b|COMPUTE\b|CLEAR\b|SHOW\s|DESC\b|DESCRIBE\b|EXIT\b|QUIT\b|WHENEVER\b|START\b|@|PAUSE\b|HOST\b|USE\s|GO\s*$|PURGE\s+RECYCLEBIN)/i;
const BLOCK_START = /^\s*(DECLARE\b|BEGIN\b|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE\s+BODY)\b)/i;

/**
 * Découpe un script en instructions. Les commandes du client (SQL*Plus, MySQL) sont ignorées.
 * @returns {{ statements: string[], skipped: string[] }}
 */
function splitStatements(script) {
  const statements = [];
  const skipped = [];
  const lines = String(script).replace(/\r\n?/g, '\n').split('\n');
  let buf = '';
  let inBlock = false;
  let blockComment = false;
  const push = () => {
    const t = buf.trim();
    if (t && !/^;+$/.test(t)) statements.push(t);
    buf = '';
    inBlock = false;
  };
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (blockComment) {
      buf += `${line}\n`;
      if (trimmed.includes('*/')) blockComment = false;
      continue;
    }
    if (!buf.trim()) {
      if (!trimmed) continue;
      if (/^\/\*/.test(trimmed) && !trimmed.includes('*/')) {
        blockComment = true;
        buf += `${line}\n`;
        continue;
      }
      if (/^\/\s*$/.test(trimmed)) continue; // « / » isolé sans instruction en cours
      if (/^EXEC(UTE)?\s+/i.test(trimmed)) {
        // EXEC proc(args) -> appel de procédure
        statements.push(`CALL ${trimmed.replace(/^EXEC(UTE)?\s+/i, '').replace(/;\s*$/, '')}`);
        continue;
      }
      if (CLIENT_CMD.test(trimmed)) {
        skipped.push(trimmed);
        continue;
      }
      if (BLOCK_START.test(trimmed)) inBlock = true;
    }
    if (inBlock) {
      // Un bloc PL/SQL se termine par « / » seul sur une ligne (ou END; suivi d'une ligne vide en fin de fichier)
      if (/^\/\s*$/.test(trimmed)) {
        push();
        continue;
      }
      buf += `${line}\n`;
      continue;
    }
    if (/^\/\s*$/.test(trimmed)) {
      push();
      continue;
    }
    if (/^GO\s*$/i.test(trimmed)) {
      push();
      continue;
    }
    // Instruction SQL ordinaire : on coupe aux « ; » hors chaînes / commentaires
    let cur = '';
    let inStr = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inStr) {
        cur += c;
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inStr = c; cur += c; continue; }
      if (c === '-' && line[i + 1] === '-') { cur += line.slice(i); break; }
      if (c === ';') {
        buf += cur;
        push();
        cur = '';
        continue;
      }
      cur += c;
    }
    buf += `${cur}\n`;
  }
  if (buf.trim()) {
    // Bloc non terminé par « / » : on retire un éventuel END; final
    push();
  }
  return { statements, skipped };
}

// ---------------------------------------------------------------- Détection du dialecte

function detectDialect(sql) {
  const s = mapCode(sql, (x) => x).toUpperCase();
  const score = { oracle: 0, mysql: 0, postgres: 0, mssql: 0 };
  const add = (k, re, w = 1) => { if (re.test(s)) score[k] += w; };
  add('oracle', /\bVARCHAR2\b|\bNUMBER\s*\(|\bNUMBER\b|\bNVL2?\s*\(|\bDECODE\s*\(|\bSYSDATE\b|\bDUAL\b|\bMINUS\b|\bROWNUM\b|\.NEXTVAL\b|\bTO_DATE\s*\(|\bDBMS_OUTPUT\b|\(\+\)|\bCASCADE\s+CONSTRAINTS\b/, 2);
  add('mysql', /`|\bAUTO_INCREMENT\b|\bENGINE\s*=|\bIFNULL\s*\(|\bDATE_FORMAT\s*\(|\bCURDATE\s*\(|\bTINYINT\b|\bUNSIGNED\b|\bLIMIT\s+\d+\s*,\s*\d+/, 2);
  add('postgres', /\bSERIAL\b|::\w+|\bILIKE\b|\$\$|\bRETURNING\b/, 2);
  add('mssql', /\bSELECT\s+TOP\b|\bGETDATE\s*\(|\bIDENTITY\s*\(|\bNVARCHAR\b|^\s*GO\s*$/m, 2);
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : 'standard';
}

// ---------------------------------------------------------------- Traductions

const ORACLE_TYPES = [
  [/\bN?VARCHAR2\b/gi, 'VARCHAR'],
  [/\bNCHAR\b/gi, 'CHAR'],
  [/\bNUMBER\b/gi, 'NUMERIC'],
  [/\bBINARY_(FLOAT|DOUBLE)\b/gi, 'DOUBLE PRECISION'],
  [/\b(PLS|BINARY)_INTEGER\b/gi, 'INTEGER'],
  [/\bN?CLOB\b/gi, 'TEXT'],
  [/\bBLOB\b/gi, 'BYTEA'],
  [/\bRAW\s*\(\s*\d+\s*\)/gi, 'BYTEA'],
  [/\bLONG\s+RAW\b/gi, 'BYTEA']
];

/** Mots-clés (appliqué hors chaînes de caractères). */
function translateKeywords(code, dialect) {
  let s = code;
  // Oracle
  s = s.replace(/\bMINUS\b/gi, 'EXCEPT');
  s = s.replace(/\bSYSDATE\b/gi, 'LOCALTIMESTAMP(0)').replace(/\bSYSTIMESTAMP\b/gi, 'CURRENT_TIMESTAMP');
  s = s.replace(/\bNVL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\b(\w+)\.NEXTVAL\b/gi, "nextval('$1')").replace(/\b(\w+)\.CURRVAL\b/gi, "currval('$1')");
  s = s.replace(/\bNOCACHE\b/gi, '').replace(/\bNOCYCLE\b/gi, 'NO CYCLE').replace(/\bNOMAXVALUE\b/gi, 'NO MAXVALUE').replace(/\bNOMINVALUE\b/gi, 'NO MINVALUE').replace(/\bNOORDER\b/gi, '');
  // Division entière d'entiers littéraux : Oracle et MySQL donnent un décimal
  if (dialect === 'oracle' || dialect === 'mysql') s = s.replace(/(\b\d+)\s*\/\s*(\d+\b)/g, '$1::numeric / $2');
  // MySQL
  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/\bCURDATE\s*\(\s*\)/gi, 'CURRENT_DATE').replace(/\bCURTIME\s*\(\s*\)/gi, 'LOCALTIME');
  s = s.replace(/\bLIMIT\s+(\d+)\s*,\s*(\d+)/gi, 'LIMIT $2 OFFSET $1');
  // SQL Server
  s = s.replace(/\bGETDATE\s*\(\s*\)/gi, 'LOCALTIMESTAMP');
  s = s.replace(/\bLEN\s*\(/gi, 'LENGTH(');
  s = s.replace(/\bISNULL\s*\(/gi, 'COALESCE(');
  return s;
}

/** Appels de fonctions à réécrire (appliqué sur l'instruction entière : les arguments peuvent être des chaînes). */
function translateCalls(code) {
  let s = code;
  s = replaceCalls(s, 'DECODE', (a) => {
    if (a.length < 3) return null;
    const [e, ...rest] = a;
    const def = rest.length % 2 ? rest.pop() : null;
    const whens = [];
    for (let i = 0; i < rest.length; i += 2) whens.push(rest[i] === 'NULL' || /^null$/i.test(rest[i]) ? `WHEN (${e}) IS NULL THEN ${rest[i + 1]}` : `WHEN (${e}) = ${rest[i]} THEN ${rest[i + 1]}`);
    return `(CASE ${whens.join(' ')}${def != null ? ` ELSE ${def}` : ''} END)`;
  });
  s = replaceCalls(s, 'NVL2', (a) => (a.length === 3 ? `(CASE WHEN (${a[0]}) IS NOT NULL THEN ${a[1]} ELSE ${a[2]} END)` : null));
  // DBMS_OUTPUT.PUT_LINE(x) -> sortie capturée
  s = replaceCalls(s, 'DBMS_OUTPUT\\.PUT_LINE', (a) => `PERFORM compat.put_line((${a.join(', ') || "''"})::text)`);
  s = replaceCalls(s, 'DBMS_OUTPUT\\.PUT', (a) => `PERFORM compat.put_line((${a.join(', ') || "''"})::text)`);
  s = replaceCalls(s, 'RAISE_APPLICATION_ERROR', (a) => `RAISE EXCEPTION '%', ${a[1] || "'erreur'"}`);
  s = replaceCalls(s, 'REGEXP_LIKE', (a) => (a.length >= 2 ? `(${a[0]} ${/'[^']*i[^']*'/.test(a[2] || '') ? '~*' : '~'} ${a[1]})` : null));
  s = replaceCalls(s, 'GROUP_CONCAT', (a) => {
    const m = a[0].match(/^([\s\S]+?)(\s+ORDER\s+BY\s+[\s\S]+?)?(\s+SEPARATOR\s+('[^']*'))?$/i);
    return m ? `string_agg((${m[1]})::text, ${m[4] || "','"}${m[2] || ''})` : null;
  });
  // LISTAGG(x, sep) WITHIN GROUP (ORDER BY y) -> string_agg(x, sep ORDER BY y)
  s = s.replace(/\bLISTAGG\s*\(([^()]+?)(?:,\s*('[^']*'))?\)\s*WITHIN\s+GROUP\s*\(\s*(ORDER\s+BY[^)]+)\)/gi, (_, x, sep, ob) => `string_agg((${x})::text, ${sep || "''"} ${ob})`);
  return s;
}

function translateExpressions(code, dialect) {
  return translateCalls(mapCode(code, (x) => translateKeywords(x, dialect)));
}

function translateDDL(code, dialect) {
  let s = code;
  if (dialect === 'oracle' || /VARCHAR2|\bNUMBER\b/i.test(s)) for (const [re, rep] of ORACLE_TYPES) s = s.replace(re, rep);
  // Oracle : DROP TABLE … CASCADE CONSTRAINTS [PURGE]
  s = s.replace(/\bCASCADE\s+CONSTRAINTS\b/gi, 'CASCADE').replace(/\bPURGE\b\s*$/i, '');
  // Oracle : ALTER TABLE t MODIFY (col type, …) / MODIFY col type
  s = s.replace(/^(\s*ALTER\s+TABLE\s+[\w."]+\s+)MODIFY\s*\(([\s\S]+)\)\s*$/i, (_, head, cols) => head + splitTopLevel(cols).map((c) => modifyColumn(c)).join(', '));
  s = s.replace(/^(\s*ALTER\s+TABLE\s+[\w."]+\s+)MODIFY\s+(?!\()([\s\S]+)$/i, (_, head, col) => head + modifyColumn(col));
  // Oracle : ALTER TABLE t ADD (col type, …)
  s = s.replace(/^(\s*ALTER\s+TABLE\s+[\w."]+\s+)ADD\s*\(([\s\S]+)\)\s*$/i, (_, head, cols) => head + splitTopLevel(cols).map((c) => (/^\s*(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(c) ? `ADD ${c.trim()}` : `ADD COLUMN ${c.trim()}`)).join(', '));
  // MySQL : types, AUTO_INCREMENT, options de table
  s = s.replace(/\b(BIGINT)\b([^,()]*?)\bAUTO_INCREMENT\b/gi, 'BIGSERIAL$2').replace(/\b(INT|INTEGER|MEDIUMINT|SMALLINT|TINYINT)\b(\s*\(\s*\d+\s*\))?([^,()]*?)\bAUTO_INCREMENT\b/gi, 'SERIAL$3');
  s = s.replace(/\b(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\s*\(\s*\d+\s*\)/gi, (m, t) => ({ TINYINT: 'SMALLINT', MEDIUMINT: 'INTEGER' }[t.toUpperCase()] || t));
  s = s.replace(/\bTINYINT\b/gi, 'SMALLINT').replace(/\bMEDIUMINT\b/gi, 'INTEGER').replace(/\bDATETIME\b/gi, 'TIMESTAMP');
  s = s.replace(/\bDOUBLE\b(?!\s+PRECISION)(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi, 'DOUBLE PRECISION').replace(/\bUNSIGNED\b/gi, '').replace(/\bLONGTEXT|MEDIUMTEXT|TINYTEXT\b/gi, 'TEXT');
  s = s.replace(/\bENUM\s*\([^)]*\)/gi, 'VARCHAR(255)').replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\))?/gi, '');
  s = s.replace(/\)\s*((ENGINE|(DEFAULT\s+)?CHARSET|(DEFAULT\s+)?CHARACTER\s+SET|COLLATE|AUTO_INCREMENT|ROW_FORMAT|COMMENT)\s*=?\s*[\w']+\s*)+$/i, ')');
  // SQL Server
  s = s.replace(/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'GENERATED BY DEFAULT AS IDENTITY').replace(/\bNVARCHAR\b/gi, 'VARCHAR').replace(/\bNVARCHAR\s*\(\s*MAX\s*\)/gi, 'TEXT');
  return s;
}

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function modifyColumn(def) {
  const m = def.trim().match(/^([\w"]+)\s+(.+)$/s);
  if (!m) return `ALTER COLUMN ${def}`;
  const [, col, rest] = m;
  const parts = [];
  const type = rest.replace(/\b(NOT\s+NULL|NULL|DEFAULT\s+.+)$/i, '').trim();
  if (type) parts.push(`ALTER COLUMN ${col} TYPE ${type}`);
  if (/\bNOT\s+NULL\b/i.test(rest)) parts.push(`ALTER COLUMN ${col} SET NOT NULL`);
  else if (/\bNULL\b/i.test(rest)) parts.push(`ALTER COLUMN ${col} DROP NOT NULL`);
  const def2 = rest.match(/\bDEFAULT\s+(.+)$/i);
  if (def2) parts.push(`ALTER COLUMN ${col} SET DEFAULT ${def2[1]}`);
  return parts.join(', ');
}

/** ROWNUM <= n (Oracle) et SELECT TOP n (SQL Server) -> LIMIT n */
function translateLimits(s) {
  let limit = null;
  let out = s;
  out = out.replace(/\bWHERE\s+ROWNUM\s*(<=|<|=)\s*(\d+)\s+AND\b/i, (_, op, n) => { limit = op === '<' ? n - 1 : Number(n); return 'WHERE'; });
  out = out.replace(/\bAND\s+ROWNUM\s*(<=|<|=)\s*(\d+)/i, (_, op, n) => { limit = op === '<' ? n - 1 : Number(n); return ''; });
  out = out.replace(/\bWHERE\s+ROWNUM\s*(<=|<|=)\s*(\d+)/i, (_, op, n) => { limit = op === '<' ? n - 1 : Number(n); return ''; });
  out = out.replace(/\bSELECT\s+(DISTINCT\s+)?TOP\s*\(?\s*(\d+)\s*\)?\s+/i, (_, d, n) => { limit = Number(n); return `SELECT ${d || ''}`; });
  if (limit != null && !/\bLIMIT\b|\bFETCH\s+FIRST\b/i.test(out)) out = `${out.trim()} LIMIT ${limit}`;
  return out;
}

// ---------------------------------------------------------------- PL/SQL -> PL/pgSQL

function plsqlBody(body) {
  let b = body;
  b = b.replace(/\bEND\s+[\w$]+\s*;?\s*$/i, 'END;');
  // FOR r IN (SELECT …) LOOP -> FOR r IN SELECT … LOOP
  b = b.replace(/\bIN\s*\(\s*(SELECT[\s\S]*?)\)\s*LOOP\b/gi, 'IN $1 LOOP');
  // EXIT WHEN c%NOTFOUND -> EXIT WHEN NOT FOUND
  b = b.replace(/\b\w+%NOTFOUND\b/gi, 'NOT FOUND').replace(/\b\w+%FOUND\b/gi, 'FOUND');
  b = b.replace(/\bSQL%ROWCOUNT\b/gi, 'compat_rowcount');
  // Déclencheurs : :NEW / :OLD, INSERTING / UPDATING / DELETING
  b = b.replace(/:\s*(NEW|OLD)\b/gi, '$1');
  b = b.replace(/\bINSERTING\b/gi, "TG_OP = 'INSERT'").replace(/\bUPDATING\b/gi, "TG_OP = 'UPDATE'").replace(/\bDELETING\b/gi, "TG_OP = 'DELETE'");
  // ELSIF identique ; « NULL; » identique
  return b;
}

/** PL/pgSQL exige de déclarer les variables de boucle sur requête (FOR r IN SELECT …) comme RECORD. */
function declareLoopRecords(code) {
  const vars = [...new Set([...code.matchAll(/\bFOR\s+(\w+)\s+IN\s+(?!REVERSE\b)(?!-?\d)(?![\w.]+\s*\.\.)/gi)].map((m) => m[1]))];
  if (!vars.length) return code;
  const decl = vars.map((v) => `  ${v} RECORD;`).join('\n');
  if (/^\s*DECLARE\b/i.test(code)) return code.replace(/^\s*DECLARE\b/i, `DECLARE\n${decl}`);
  return code.replace(/^\s*BEGIN\b/i, `DECLARE\n${decl}\nBEGIN`);
}

/** Convertit un bloc PL/SQL Oracle. Renvoie une liste d'instructions PostgreSQL. */
function translatePlsql(stmt, procNames) {
  let s = stmt.trim().replace(/\/\s*$/, '').trim();
  const callify = (body) => body.replace(new RegExp(`(^|;|\\bBEGIN|\\bTHEN|\\bELSE|\\bLOOP)(\\s*)(${[...procNames].join('|') || '__none__'})\\s*(\\(|;)`, 'gim'), (m, a, sp, name, t) => `${a}${sp}CALL ${name}${t === ';' ? '();' : '('}`);
  // Bloc anonyme
  if (/^(DECLARE|BEGIN)\b/i.test(s)) {
    const body = declareLoopRecords(plsqlBody(callify(s.replace(/;\s*$/, ';'))));
    return [`DO $plsql$\n${body.replace(/END\s*;?\s*$/i, 'END;')}\n$plsql$`];
  }
  // Procédure / fonction
  let m = s.match(/^CREATE\s+(OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION)\s+([\w."]+)\s*(\([\s\S]*?\))?\s*(RETURN\s+([\w%.()]+)\s*)?(IS|AS)\b([\s\S]*)$/i);
  if (m) {
    const [, , kind, name, params = '', , ret, , rest] = m;
    procNames.add(name);
    const p = params ? `(${splitTopLevel(params.slice(1, -1)).map((x) => x.trim().replace(/^([\w"]+)\s+(IN\s+OUT|IN|OUT)\s+/i, (_, n, mode) => `${mode.toUpperCase() === 'IN OUT' ? 'INOUT' : mode} ${n} `).replace(/\bDEFAULT\b/i, 'DEFAULT')).join(', ')})` : '()';
    let body = rest.trim();
    const beginIdx = body.search(/\bBEGIN\b/i);
    const decls = beginIdx > 0 ? body.slice(0, beginIdx).trim() : '';
    body = beginIdx >= 0 ? body.slice(beginIdx) : body;
    const code = declareLoopRecords(`${decls ? `DECLARE\n${decls}\n` : ''}${plsqlBody(callify(body))}`);
    const retType = ret ? ` RETURNS ${ret}` : '';
    return [`CREATE OR REPLACE ${kind.toUpperCase()} ${name}${p}${retType} LANGUAGE plpgsql AS $plsql$\n${code}\n$plsql$`];
  }
  // Déclencheur
  m = s.match(/^CREATE\s+(OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?TRIGGER\s+([\w."]+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]+?)\s+ON\s+([\w."]+)\s*(FOR\s+EACH\s+ROW)?\s*(WHEN\s*\(([\s\S]+?)\))?\s*((DECLARE[\s\S]*?)?BEGIN[\s\S]*)$/i);
  if (m) {
    const [, , name, timing, events, table, forEach, , when, body] = m;
    const fn = `${name.replace(/"/g, '')}_fn`;
    let code = plsqlBody(callify(body.trim()));
    // Un déclencheur PL/pgSQL doit renvoyer la ligne
    code = code.replace(/END\s*;?\s*$/i, `RETURN ${/DELETE/i.test(events) && !/INSERT|UPDATE/i.test(events) ? 'OLD' : 'NEW'};\nEND;`);
    return [
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $plsql$\n${code}\n$plsql$`,
      `DROP TRIGGER IF EXISTS ${name} ON ${table}`,
      `CREATE TRIGGER ${name} ${timing.toUpperCase()} ${events.replace(/\bOR\b/gi, 'OR')} ON ${table} ${forEach ? 'FOR EACH ROW' : 'FOR EACH STATEMENT'}${when ? ` WHEN (${plsqlBody(when)})` : ''} EXECUTE FUNCTION ${fn}()`
    ];
  }
  return null;
}

// ---------------------------------------------------------------- Point d'entrée

const UNSUPPORTED = [
  [/\(\+\)/, 'jointure externe Oracle « (+) »'],
  [/\bCONNECT\s+BY\b|\bSTART\s+WITH\b(?![^;]*\bINCREMENT\b)/i, 'requête hiérarchique Oracle (CONNECT BY)'],
  [/\bCREATE\s+(OR\s+REPLACE\s+)?PACKAGE\b/i, 'paquetage PL/SQL'],
  [/\bMERGE\s+INTO\b/i, 'MERGE Oracle'],
  [/\bPIVOT\s*\(/i, 'PIVOT'],
  [/\bON\s+DUPLICATE\s+KEY\b/i, 'INSERT … ON DUPLICATE KEY UPDATE (MySQL)'],
  [/^\s*REPLACE\s+INTO\b/i, 'REPLACE INTO (MySQL)'],
  [/\bINSERT\s+IGNORE\b/i, 'INSERT IGNORE (MySQL)']
];

/** Jointures Oracle « (+) » simples (a.x = b.y(+)) -> LEFT JOIN. */
function translateOuterJoin(stmt) {
  const m = stmt.match(/^([\s\S]*?\bFROM\s+)([\s\S]+?)(\s+WHERE\s+)([\s\S]+?)(\s+(GROUP\s+BY|ORDER\s+BY|HAVING|UNION|EXCEPT|INTERSECT)[\s\S]*)?$/i);
  if (!m) return null;
  const [, head, from, , where, tail = ''] = m;
  const tables = splitTopLevel(from).map((t) => t.trim());
  if (tables.length !== 2) return null;
  const alias = (t) => (t.split(/\s+/).pop());
  const conds = where.split(/\s+AND\s+/i);
  const outer = conds.filter((c) => /\(\+\)/.test(c));
  const rest = conds.filter((c) => !/\(\+\)/.test(c));
  if (!outer.length) return null;
  const optAlias = (outer[0].match(/([\w"]+)\.[\w"]+\s*\(\+\)/) || [])[1];
  if (!optAlias) return null;
  const optional = tables.find((t) => alias(t) === optAlias);
  const main = tables.find((t) => t !== optional);
  if (!optional || !main) return null;
  const on = outer.map((c) => c.replace(/\(\+\)/g, '')).join(' AND ');
  return `${head}${main} LEFT JOIN ${optional} ON ${on}${rest.length ? ` WHERE ${rest.join(' AND ')}` : ''}${tail}`;
}

/**
 * Prépare un script pour PostgreSQL.
 * @returns {{ dialect, items: [{ original, sql: string[], plsql: boolean, unsupported?: string }], skipped: string[] }}
 */
function prepareScript(script) {
  const dialect = detectDialect(script);
  let src = String(script);
  if (dialect === 'mysql' || src.includes('`')) src = backticksToQuotes(src);
  const { statements, skipped } = splitStatements(src);
  const procNames = new Set();
  const items = [];
  for (const original of statements) {
    if (/^\s*(USE\s|SHOW\s|CREATE\s+DATABASE|DROP\s+DATABASE|COMMIT\b|ROLLBACK\b|START\s+TRANSACTION|BEGIN\s+TRANSACTION|SAVEPOINT\b|GRANT\b|REVOKE\b|ANALYZE\b|ALTER\s+SESSION\b|SET\s+(NAMES|FOREIGN_KEY_CHECKS|SQL_MODE|TIME_ZONE|AUTOCOMMIT|TRANSACTION)\b)/i.test(original)) {
      skipped.push(original.split('\n')[0]);
      continue;
    }
    if (BLOCK_START.test(original)) {
      const t = translatePlsql(translateExpressions(translateDDL(original, 'oracle'), 'oracle'), procNames);
      if (t) items.push({ original, sql: t, plsql: true });
      else items.push({ original, sql: [original], plsql: true, unsupported: 'bloc PL/SQL' });
      continue;
    }
    // Oracle : INSERT ALL INTO t VALUES (…) INTO t VALUES (…) SELECT * FROM dual -> plusieurs INSERT
    const insAll = original.match(/^\s*INSERT\s+ALL\s+([\s\S]+?)\s+SELECT\s+\*\s+FROM\s+DUAL\s*$/i);
    if (insAll) {
      const parts = insAll[1].split(/\s+(?=INTO\s)/i).map((p) => p.trim()).filter(Boolean);
      items.push({ original, sql: parts.map((p) => translateExpressions(`INSERT ${p}`, dialect)), plsql: false });
      continue;
    }
    let sql = translateLimits(translateExpressions(translateDDL(original, dialect), dialect));
    let unsupported = null;
    const codeOnly = original.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
    for (const [re, label] of UNSUPPORTED) if (re.test(codeOnly)) unsupported = label;
    if (/\(\+\)/.test(sql)) {
      const oj = translateOuterJoin(sql);
      if (oj) {
        sql = oj;
        unsupported = null;
      }
    }
    items.push({ original, sql: [sql], plsql: false, unsupported });
  }
  return { dialect, items, skipped };
}

/** Fonctions et objets de compatibilité créés dans le schéma « compat » (Oracle / MySQL / SQL Server). */
const COMPAT_SETUP = `
CREATE SCHEMA IF NOT EXISTS compat;
CREATE TABLE IF NOT EXISTS compat.dual (dummy VARCHAR(1));
INSERT INTO compat.dual SELECT 'X' WHERE NOT EXISTS (SELECT 1 FROM compat.dual);
CREATE TABLE IF NOT EXISTS compat.output (id SERIAL, line TEXT);
CREATE OR REPLACE FUNCTION compat.put_line(t TEXT) RETURNS void LANGUAGE sql AS $$ INSERT INTO compat.output(line) VALUES (COALESCE(t, '')) $$;
CREATE OR REPLACE FUNCTION compat.add_months(d TIMESTAMP, n NUMERIC) RETURNS TIMESTAMP LANGUAGE sql IMMUTABLE AS $$ SELECT d + make_interval(months => n::int) $$;
CREATE OR REPLACE FUNCTION compat.months_between(a TIMESTAMP, b TIMESTAMP) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT ((EXTRACT(YEAR FROM a) - EXTRACT(YEAR FROM b)) * 12 + (EXTRACT(MONTH FROM a) - EXTRACT(MONTH FROM b)) + (EXTRACT(DAY FROM a) - EXTRACT(DAY FROM b)) / 31.0)::NUMERIC $$;
CREATE OR REPLACE FUNCTION compat.trunc(d TIMESTAMP) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$ SELECT d::DATE $$;
CREATE OR REPLACE FUNCTION compat.trunc(d TIMESTAMP, f TEXT) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$ SELECT date_trunc(CASE upper(f) WHEN 'MM' THEN 'month' WHEN 'MONTH' THEN 'month' WHEN 'YYYY' THEN 'year' WHEN 'YEAR' THEN 'year' WHEN 'Q' THEN 'quarter' ELSE 'day' END, d)::DATE $$;
CREATE OR REPLACE FUNCTION compat.last_day(d TIMESTAMP) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$ SELECT (date_trunc('month', d) + INTERVAL '1 month - 1 day')::DATE $$;
CREATE OR REPLACE FUNCTION compat.instr(s TEXT, sub TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT strpos(s, sub) $$;
CREATE OR REPLACE FUNCTION compat.to_number(s TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT replace(s, ',', '.')::NUMERIC $$;
CREATE OR REPLACE FUNCTION compat.to_number(s NUMERIC) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT s $$;
CREATE OR REPLACE FUNCTION compat.to_char(n NUMERIC) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT n::TEXT $$;
CREATE OR REPLACE FUNCTION compat.to_char(d TIMESTAMP) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(d, 'DD/MM/YY') $$;
CREATE OR REPLACE FUNCTION compat.round(x DOUBLE PRECISION, n INT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT round(x::NUMERIC, n) $$;
CREATE OR REPLACE FUNCTION compat.year(d TIMESTAMPTZ) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT EXTRACT(YEAR FROM d)::INT $$;
CREATE OR REPLACE FUNCTION compat.month(d TIMESTAMPTZ) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT EXTRACT(MONTH FROM d)::INT $$;
CREATE OR REPLACE FUNCTION compat.day(d TIMESTAMPTZ) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT EXTRACT(DAY FROM d)::INT $$;
CREATE OR REPLACE FUNCTION compat.dayofmonth(d TIMESTAMPTZ) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT EXTRACT(DAY FROM d)::INT $$;
CREATE OR REPLACE FUNCTION compat.datediff(a TIMESTAMPTZ, b TIMESTAMPTZ) RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT (a::DATE - b::DATE) $$;
CREATE OR REPLACE FUNCTION compat.date_format(d TIMESTAMPTZ, f TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(d, replace(replace(replace(replace(replace(replace(replace(replace(replace(f, '%d', 'DD'), '%m', 'MM'), '%Y', 'YYYY'), '%y', 'YY'), '%H', 'HH24'), '%i', 'MI'), '%s', 'SS'), '%M', 'FMMonth'), '%W', 'FMDay')) $$;
CREATE OR REPLACE FUNCTION compat.str_to_date(s TEXT, f TEXT) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT to_date(s, replace(replace(replace(replace(f, '%d', 'DD'), '%m', 'MM'), '%Y', 'YYYY'), '%y', 'YY')) $$;
CREATE OR REPLACE FUNCTION compat.nvl(a ANYCOMPATIBLE, b ANYCOMPATIBLE) RETURNS ANYCOMPATIBLE LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(a, b) $$;
`;

const SEARCH_PATH = 'SET search_path TO public, compat';

module.exports = { prepareScript, splitStatements, detectDialect, translateExpressions, translateKeywords, translateCalls, translateDDL, translateLimits, translatePlsql, mapCode, COMPAT_SETUP, SEARCH_PATH };
