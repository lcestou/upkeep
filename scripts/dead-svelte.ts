/**
 * Find declarations in the scripts of .svelte files that nothing in their file refers to.
 *
 * fallow follows imports between files and oxlint reads a component's script without its
 * template, so neither can tell that a function declared in a component is never called. This
 * script can: it counts every mention of a name in the whole file, template and comments
 * included, and reports a declaration whose name appears nowhere outside its own statement.
 *
 * Only declarations that cannot have a side effect are considered: functions, arrow functions,
 * literals, `$state` and `$derived` values, and import bindings. Exported declarations are a
 * component's public API and are left alone. A name that is only mentioned in a comment counts
 * as used, so the check errs towards keeping code.
 *
 * Usage:
 *   bun scripts/dead-svelte.ts            report, exit 1 when anything is found
 *   bun scripts/dead-svelte.ts --write    remove what it finds, repeating until nothing is left
 *   bun scripts/dead-svelte.ts a.svelte   check the given files instead of everything under src/
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

/** A stretch of a file to delete, and the name it declares. */
interface Cut {
	start: number;
	end: number;
	name: string;
}

/** Every .svelte file under a directory, depth first. */
function svelteFilesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return svelteFilesUnder(path);
		return entry.name.endsWith(".svelte") ? [path] : [];
	});
}

/** How many times `name` appears in `text` as a whole identifier, not as a property after a dot. */
function mentions(text: string, name: string): number {
	const escaped = name.replaceAll("$", "\\$");
	// `...name` (spread) is a use; `object.name` is a property of something else.
	const pattern = new RegExp(`(?<![\\w$])(?<!(?<!\\.\\.)\\.)${escaped}(?![\\w$])`, "g");
	return text.match(pattern)?.length ?? 0;
}

/** Whether an initializer can be dropped without changing what runs. */
function isInert(initializer: ts.Expression | undefined): boolean {
	if (initializer === undefined) return true;
	if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
		return isInert(initializer.expression);
	}
	if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return true;
	if (ts.isStringLiteralLike(initializer) || ts.isNumericLiteral(initializer)) return true;
	if (ts.isCallExpression(initializer)) {
		const callee = initializer.expression.getText();
		return ["$state", "$state.raw", "$derived", "$derived.by"].includes(callee);
	}
	return false;
}

/** Whether a statement carries the `export` keyword. */
function isExported(statement: ts.Statement): boolean {
	return (
		ts.canHaveModifiers(statement) &&
		(ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
	);
}

/** The name a function or single-variable statement declares, when it is one this check covers. */
function declaredName(statement: ts.Statement): string | undefined {
	if (ts.isFunctionDeclaration(statement)) return statement.name?.text;
	if (!ts.isVariableStatement(statement)) return undefined;
	const [declaration, ...others] = statement.declarationList.declarations;
	if (!declaration || others.length > 0 || !ts.isIdentifier(declaration.name)) return undefined;
	return isInert(declaration.initializer) ? declaration.name.text : undefined;
}

/** Where a statement starts once the comment lines directly above it are included. */
function startWithComments(text: string, start: number): number {
	let lineStart = text.lastIndexOf("\n", start - 1) + 1;
	while (lineStart > 0) {
		const previousStart = text.lastIndexOf("\n", lineStart - 2) + 1;
		const previous = text.slice(previousStart, lineStart - 1).trim();
		const isComment = previous.startsWith("//") || previous.startsWith("/*") || previous.startsWith("*");
		if (!isComment) break;
		lineStart = previousStart;
	}
	return lineStart;
}

/** The unused import bindings of one import statement, as cuts in file coordinates. */
function deadImports(statement: ts.ImportDeclaration, text: string, offset: number): Cut[] {
	const clause = statement.importClause;
	if (!clause) return [];
	const own = statement.getText();
	const isDead = (name: string) => mentions(text, name) - mentions(own, name) === 0;
	const named =
		clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? [...clause.namedBindings.elements] : [];
	const deadNamed = named.filter((element) => isDead(element.name.text));
	const defaultDead = clause.name === undefined || isDead(clause.name.text);
	const namespaceDead =
		clause.namedBindings === undefined ||
		!ts.isNamespaceImport(clause.namedBindings) ||
		isDead(clause.namedBindings.name.text);

	if (defaultDead && namespaceDead && deadNamed.length === named.length) {
		const names = [clause.name?.text, ...named.map((element) => element.name.text)].filter(Boolean);
		return [
			{
				start: offset + statement.getStart(),
				end: offset + statement.end,
				name: `import ${names.join(", ")}`,
			},
		];
	}
	return deadNamed.map((element) => {
		// Take the binding together with the comma after it, or the one before when it is last.
		let start = offset + element.getStart();
		let end = offset + element.end;
		const after = text.slice(end).match(/^\s*,[ \t]*/);
		const before = text.slice(0, start).match(/,\s*$/);
		if (after) end += after[0].length;
		else if (before) start -= before[0].length;
		return { start, end, name: `import ${element.name.text}` };
	});
}

/** Everything unused in one file's script blocks. */
function findDead(text: string): Cut[] {
	const root = parse(text, { modern: true });
	const cuts: Cut[] = [];
	for (const script of [root.instance, root.module]) {
		if (!script) continue;
		// The parsed body's own range: searching for the tag's ">" would stop inside an attribute
		// that holds one, such as generics="T extends Map<string, number>"
		// SAFETY: Svelte's parser gives every node numeric start and end offsets, the script's Program
		// included; its types reuse ESTree's Program, which leaves them off.
		const content = script.content as typeof script.content & { start: number; end: number };
		const offset = content.start;
		const body = text.slice(offset, content.end);
		const source = ts.createSourceFile("script.ts", body, ts.ScriptTarget.Latest, true);
		for (const statement of source.statements) {
			if (ts.isImportDeclaration(statement)) {
				cuts.push(...deadImports(statement, text, offset));
				continue;
			}
			const name = isExported(statement) ? undefined : declaredName(statement);
			if (name === undefined) continue;
			if (mentions(text, name) - mentions(statement.getText(), name) > 0) continue;
			cuts.push({ start: offset + statement.getStart(), end: offset + statement.end, name });
		}
	}
	return cuts;
}

/** The file's text with the cuts taken out, whole lines where a cut leaves a line empty. */
function applyCuts(text: string, cuts: Cut[]): string {
	let result = text;
	for (const cut of cuts.toSorted((a, b) => b.start - a.start)) {
		const isImportBinding = cut.name.startsWith("import ") && result[cut.end] !== ";";
		let start = isImportBinding ? cut.start : startWithComments(result, cut.start);
		let end = cut.end;
		if (result[end] === ";") end++;
		const lineStart = result.lastIndexOf("\n", start - 1) + 1;
		// The last line of a file with no final newline ends at the end of the text.
		const newline = result.indexOf("\n", end);
		const lineEnd = newline === -1 ? result.length : newline;
		const rest = result.slice(lineStart, start) + result.slice(end, lineEnd);
		if (rest.trim() === "") {
			start = lineStart;
			end = newline === -1 ? lineEnd : lineEnd + 1;
			// one blank line less, so a removed block does not leave two in a row
			if (result[end] === "\n" && result[start - 2] === "\n") end++;
		}
		result = result.slice(0, start) + result.slice(end);
	}
	return result;
}

const args = process.argv.slice(2);
const shouldWrite = args.includes("--write");
const named = args.filter((arg) => arg !== "--write");
const files = named.length > 0 ? named : svelteFilesUnder("src");

let total = 0;
for (const file of files) {
	let text = readFileSync(file, "utf8");
	const found: string[] = [];
	// Removing one declaration can leave another without a caller, so go round until it settles.
	for (let round = 0; round < 30; round++) {
		const cuts = findDead(text);
		if (cuts.length === 0) break;
		found.push(...cuts.map((cut) => cut.name));
		if (!shouldWrite) break;
		text = applyCuts(text, cuts);
	}
	if (found.length === 0) continue;
	total += found.length;
	console.log(`${file}: ${found.join(", ")}`);
	if (shouldWrite) writeFileSync(file, text);
}

if (total === 0) {
	console.log("dead-svelte: nothing unused");
} else if (shouldWrite) {
	console.log(`dead-svelte: removed ${total}`);
} else {
	console.log(`dead-svelte: ${total} unused. Run with --write to remove them.`);
	process.exitCode = 1;
}
