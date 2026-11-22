// Copyright (C) 2026  W. M. Martinez
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

"use strict";

/**
 * Replace comments with spaces while preserving line and character offsets.
 * Quoted strings are retained so comment markers inside them are not stripped.
 * @param {string} text Source text.
 * @returns {string[]} Comment-free source lines.
 */
function uncommentLines(text) {
  let inBlock = false;
  return text.split(/\r\n|\r|\n/).map(line => {
    let result = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (inBlock) {
        if (line[i] === "*" && line[i + 1] === "/") {
          result += "  ";
          i++;
          inBlock = false;
        } else {
          result += " ";
        }
      } else if (quoted && line[i] === "\\" && i + 1 < line.length) {
        result += line[i] + line[++i];
      } else if (line[i] === '"') {
        quoted = !quoted;
        result += line[i];
      } else if (!quoted && line[i] === "/" && line[i + 1] === "/") {
        result += " ".repeat(line.length - i);
        break;
      } else if (!quoted && line[i] === "/" && line[i + 1] === "*") {
        result += "  ";
        i++;
        inBlock = true;
      } else {
        result += line[i];
      }
    }
    return result;
  });
}

/**
 * Pair comment-free source lines with adjacent and inline comment metadata.
 * Blank lines separate a leading comment from a subsequent declaration.
 */
function sourceLines(text) {
  const raw = text.split(/\r\n|\r|\n/);
  const clean = uncommentLines(text);
  const comments = raw.map(() => []);
  let line = 0;
  let offset = 0;
  const pattern = /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;
  for (const match of text.matchAll(pattern)) {
    while (line < raw.length - 1 && offset + raw[line].length < match.index) {
      offset += raw[line].length;
      if (text[offset] === "\r") offset++;
      if (text[offset] === "\n") offset++;
      line++;
    }
    if (match[0][0] === '"') continue;
    const standalone = !clean[line].slice(0, match.index - offset).trim();
    const parts = match[0].split(/\r\n|\r|\n/);
    const formatted = parts.map(part => part.replace(/\s*\*\/\s*$/, "").replace(/^\s*(?:\/\/\/?|\/\*+|\*)\s?/, "").trim());
    for (let i = 0; i < parts.length; i++) {
      comments[line + i].push({
        start: i ? 0 : match.index - offset,
        standalone,
        text: formatted[i],
        inlineText: i === 0 ? formatted.join("\n").trim() : ""
      });
    }
  }
  let preceding = [];
  return clean.map((text, line) => {
    const leadingComment = text.trim() ? preceding.join("\n").trim() : "";
    if (!text.trim() && raw[line].trim() && comments[line].length &&
        comments[line].every(comment => comment.standalone)) {
      preceding.push(...comments[line].map(comment => comment.text));
    } else {
      preceding = [];
    }
    return { text, comments: comments[line], leadingComment };
  });
}

/**
 * Combine the leading comment of a declaration with the comment immediately
 * following its terminator. Both arguments are semantic tokens with source entries.
 * @returns {string} Documentation text, or an empty string.
 */
function definitionComment(start, end) {
  const leading = start.entry.leadingComment;
  const inline = end.entry.comments.find(comment => comment.start >= end.character + end.value.length &&
    !end.entry.text.slice(end.character + end.value.length, comment.start).trim());
  return [leading, inline && inline.inlineText].filter(Boolean).join("\n");
}

/**
 * Parse an include directive from a comment-free source line.
 * @param {string} text Source line.
 * @returns {{path: string, optional: boolean}|null}
 */
function includeAtLine(text) {
  const match = text.match(/^\s*#\s*(?:(pragma)\s+)?(include|include_optional)\s+"([^"]+)"/);
  if (!match || (match[2] === "include_optional" && !match[1])) return null;
  return { path: match[3], optional: match[2] === "include_optional" };
}

/**
 * Evaluate the limited expressions used by RetroArch-style shader preprocessor
 * directives. Unknown names and unsupported constructs evaluate conservatively
 * to false; arithmetic and boolean operators are recognized.
 * @param {string} expression Preprocessor expression.
 * @param {Set<string>} definitions Currently active macro names.
 * @param {Map<string, {replacement: string}>} defines Macro definitions.
 * @returns {boolean|number}
 */
function evaluatePreprocessor(expression, definitions, defines) {
  let source = expression.replace(/\bdefined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, name) => definitions.has(name) ? "1" : "0");
  source = source.replace(/\bdefined\s+([A-Za-z_]\w*)\b/g, (_, name) => definitions.has(name) ? "1" : "0");
  source = source.replace(/[A-Za-z_]\w*/g, name => {
    if (name === "true") return "1";
    if (name === "false") return "0";
    if (!definitions.has(name)) return "0";
    const replacement = defines.get(name)?.replacement.trim();
    return /^[-+]?(?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d+)?)$/.test(replacement || "") ? replacement : "1";
  });
  const tokens = source.match(/(?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d*)?|\.\d+|&&|\|\||==|!=|<=|>=|[()+\-*!/%<>&|])/g) || [];
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  function number() {
    const value = take();
    if (!value) return 0;
    if (/^0[xX]/.test(value)) return parseInt(value, 16);
    return Number(value);
  }
  function primary() {
    if (peek() === "(") {
      take();
      const value = ternary();
      if (peek() === ")") take();
      return value;
    }
    if (peek() === "!") {
      take();
      return primary() ? 0 : 1;
    }
    if (peek() === "+" || peek() === "-") {
      const operator = take();
      const value = primary();
      return operator === "-" ? -value : value;
    }
    return number();
  }
  function multiplicative() {
    let value = primary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = take();
      const right = primary();
      value = operator === "*" ? value * right : operator === "/" ? value / right : value % right;
    }
    return value;
  }
  function additive() {
    let value = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = multiplicative();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }
  function relational() {
    let value = additive();
    while (["<", "<=", ">", ">="].includes(peek())) {
      const operator = take();
      const right = additive();
      if (operator === "<") value = value < right ? 1 : 0;
      else if (operator === "<=") value = value <= right ? 1 : 0;
      else if (operator === ">") value = value > right ? 1 : 0;
      else value = value >= right ? 1 : 0;
    }
    return value;
  }
  function equality() {
    let value = relational();
    while (peek() === "==" || peek() === "!=") {
      const operator = take();
      const right = relational();
      value = operator === "==" ? (value === right ? 1 : 0) : (value !== right ? 1 : 0);
    }
    return value;
  }
  function logicalAnd() {
    let value = equality();
    while (peek() === "&&") {
      take();
      const right = equality();
      value = value && right ? 1 : 0;
    }
    return value;
  }
  function logicalOr() {
    let value = logicalAnd();
    while (peek() === "||") {
      take();
      const right = logicalAnd();
      value = value || right ? 1 : 0;
    }
    return value;
  }
  function ternary() {
    let value = logicalOr();
    // The RA preprocessor commonly uses integers and short-circuitable boolean
    // expressions; ternary expressions are intentionally not admitted here.
    return value;
  }
  return ternary();
}

/**
 * Expand includes in source order and collect stages, parameters and aliases.
 * The resolver maps an including URI and path to a URI; read returns a source
 * object or null for a missing file. Each expanded entry retains its own URI and
 * line as well as rootLine, the root document's line for diagnostics. Stage
 * directives propagate through include boundaries. Cycles and read failures are
 * reported in issues; a missing optional include sets missingOptional instead.
 * @param {{uri: object, text: string}} root Root source.
 * @param {function(object, string): object} resolve Resolve an include URI.
 * @param {function(object): Promise<?{uri: object, text: string}>} read Read a source.
 * @returns {Promise<object>} Expanded entries, declarations, issues and dependencies.
 */
async function buildIncludeModel(root, resolve, read) {
  const entries = [];
  const issues = [];
  const dependencies = new Set();
  const active = new Set();
  const defines = new Map();
  let missingOptional = false;
  const frames = [];
  const preprocessorActive = () => frames.every(frame => frame.active);
  const preprocessorUncertain = () => frames.some(frame => frame.uncertain);

  async function visit(source, rootLine) {
    const key = source.uri.toString();
    active.add(key);
    const lines = sourceLines(source.text);
    const baseDepth = frames.length;
    for (let line = 0; line < lines.length; line++) {
      const location = { uri: source.uri, line, rootLine: rootLine === null ? line : rootLine };
      const clean = lines[line].text;
      const directive = clean.match(/^\s*#\s*(\w+)\b(.*)$/);
      const name = directive ? directive[1].toLowerCase() : null;
      const argument = directive ? directive[2].trim() : "";
      const isActive = preprocessorActive();
      const conditional = preprocessorUncertain() || frames.length > 0;

      if (name === "define" && isActive) {
        const match = clean.match(/^\s*#\s*define\s+([A-Za-z_]\w*)(?:\s*\(([^)]*)\))?\s*(.*?)\s*$/);
        if (match) {
          const macro = {
            uri: source.uri, line, rootLine: location.rootLine,
            name: match[1], character: clean.indexOf(match[1]),
            parameters: match[2] ? match[2].split(",").map(value => value.trim()).filter(Boolean) : null,
            replacement: match[3], stage: null
          };
          macro.documentation = [
            lines[line].leadingComment,
            ...lines[line].comments.filter(comment => !comment.standalone).map(comment => comment.inlineText)
          ].filter(Boolean).join("\n");
          defines.set(macro.name, macro);
        }
        entries.push({ ...location, ...lines[line], conditional });
        continue;
      }
      if (name === "undef") {
        if (isActive) issues.push({ ...location, message: "The RA preprocessor does not support #undef." });
        entries.push({ ...location, ...lines[line], conditional });
        continue;
      }
      if (name === "ifndef") {
        if (isActive) issues.push({ ...location, message: "The RA preprocessor does not support #ifndef." });
        frames.push({ parentActive: isActive, active: false, matched: false, uncertain: true });
        entries.push({ ...location, ...lines[line], conditional: true });
        continue;
      }
      if (name === "ifdef" || name === "if") {
        const result = name === "ifdef" ?
          /^\s*([A-Za-z_]\w*)\s*$/.test(argument) && defines.has(argument.trim()) :
          Boolean(evaluatePreprocessor(argument, new Set(defines.keys()), defines));
        frames.push({ parentActive: isActive, active: isActive && result, matched: result, uncertain: false });
        entries.push({ ...location, ...lines[line], conditional });
        continue;
      }
      if (name === "elif" || name === "else") {
        const frame = frames[frames.length - 1];
        if (frame) {
          if (name === "elif" && !frame.matched) {
            const result = Boolean(evaluatePreprocessor(argument, new Set(defines.keys()), defines));
            frame.active = frame.parentActive && result;
            frame.matched = result;
          } else if (name === "else") {
            frame.active = frame.parentActive && !frame.matched;
            frame.matched = true;
          }
        }
        entries.push({ ...location, ...lines[line], conditional: true });
        continue;
      }
      if (name === "endif") {
        if (frames.length) frames.pop();
        entries.push({ ...location, ...lines[line], conditional: true });
        continue;
      }
      if (!isActive) {
        entries.push({ ...location, ...lines[line], conditional: true });
        continue;
      }

      const include = includeAtLine(clean);
      if (!include) {
        entries.push({ ...location, ...lines[line], conditional });
        continue;
      }

      const target = resolve(source.uri, include.path);
      const targetKey = target.toString();
      dependencies.add(targetKey);
      if (active.has(targetKey)) {
        issues.push({ ...location, message: `Cyclic include "${include.path}".` });
        continue;
      }
      let included;
      try {
        included = await read(target);
      } catch (error) {
        issues.push({ ...location, message: `Cannot read include "${include.path}": ${error.message}` });
        continue;
      }
      if (!included) {
        if (!include.optional) issues.push({ ...location, message: `Include "${include.path}" was not found.` });
        else missingOptional = true;
        continue;
      }
      await visit(included, location.rootLine);
    }
    while (frames.length > baseDepth) frames.pop();
    active.delete(key);
  }

  await visit(root, null);
  let stage = null;
  const parameters = [];
  const aliases = [];
  for (const entry of entries) {
    const stageMatch = entry.text.match(/^\s*#\s*pragma\s+stage\s+(vertex|fragment)\s*$/i);
    if (stageMatch) stage = stageMatch[1].toLowerCase();
    entry.stage = stage;
    const alias = entry.text.match(/^\s*#\s*pragma\s+(?:name|alias)\s+([A-Za-z_]\w*)\s*$/);
    if (alias) {
      aliases.push({ ...entry, name: alias[1], character: entry.text.lastIndexOf(alias[1]) });
    }
    const match = entry.text.match(/^\s*#\s*pragma\s+parameter\s+([A-Za-z_]\w*)\s+"([^"]*)"\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?\s*$/);
    if (match) {
      const character = entry.text.indexOf(match[1], entry.text.indexOf("parameter") + "parameter".length);
      parameters.push({
        ...entry,
        name: match[1],
        character,
        description: match[2],
        values: match.slice(3).filter(value => value !== undefined).join(" "),
        signature: JSON.stringify(match.slice(2)),
        documentation: [entry.leadingComment, ...entry.comments.filter(comment => !comment.standalone).map(comment => comment.inlineText)].filter(Boolean).join("\n")
      });
    }
  }
  for (const define of defines.values()) {
    define.stage = entries.find(entry => entry.uri.toString() === define.uri.toString() &&
      entry.line === define.line)?.stage || null;
  }
  return { entries, parameters, aliases, defines: [...defines.values()], issues, dependencies, missingOptional };
}

module.exports = { buildIncludeModel, definitionComment, includeAtLine, uncommentLines };
