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

function definitionComment(start, end) {
  const leading = start.entry.leadingComment;
  const inline = end.entry.comments.find(comment => comment.start >= end.character + end.value.length &&
    !end.entry.text.slice(end.character + end.value.length, comment.start).trim());
  return [leading, inline && inline.inlineText].filter(Boolean).join("\n");
}

function includeAtLine(text) {
  const match = text.match(/^\s*#\s*(?:(pragma)\s+)?(include|include_optional)\s+"([^"]+)"/);
  if (!match || (match[2] === "include_optional" && !match[1])) return null;
  return { path: match[3], optional: match[2] === "include_optional" };
}

async function buildIncludeModel(root, resolve, read) {
  const entries = [];
  const issues = [];
  const dependencies = new Set();
  const active = new Set();
  let missingOptional = false;

  async function visit(source, rootLine) {
    const key = source.uri.toString();
    active.add(key);
    const lines = sourceLines(source.text);
    for (let line = 0; line < lines.length; line++) {
      const location = { uri: source.uri, line, rootLine: rootLine === null ? line : rootLine };
      const include = includeAtLine(lines[line].text);
      if (!include) {
        entries.push({ ...location, ...lines[line] });
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
  return { entries, parameters, aliases, issues, dependencies, missingOptional };
}

module.exports = { buildIncludeModel, definitionComment, includeAtLine, uncommentLines };
