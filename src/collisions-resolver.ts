import * as ts from 'typescript';

import {
	getActualSymbol,
	getClosestModuleLikeNode,
	getDeclarationNameSymbol,
	getDeclarationsForSymbol,
	resolveGlobalName,
} from './helpers/typescript';
import { verboseLog } from './logger';

const renamingSupportedSymbols: readonly ts.SymbolFlags[] = [
	ts.SymbolFlags.Alias,
	ts.SymbolFlags.Variable,
	ts.SymbolFlags.Class,
	ts.SymbolFlags.Enum,
	ts.SymbolFlags.Function,
	ts.SymbolFlags.Interface,
	ts.SymbolFlags.NamespaceModule,
	ts.SymbolFlags.TypeAlias,
	ts.SymbolFlags.ValueModule,
];

export interface ResolverIdentifier {
	name: string;
	identifier?: ts.Identifier;
}

/**
 * A class that holds information about top-level scoped names and allows to get collision-free names in one occurred.
 */
export class CollisionsResolver {
	private typeChecker: ts.TypeChecker;

	private collisionsMap: Map<string, Map<ts.Symbol, string>> = new Map();
	private generatedNames: Map<ts.Symbol, Set<string>> = new Map();

	public constructor(typeChecker: ts.TypeChecker) {
		this.typeChecker = typeChecker;
	}

	/**
	 * Adds (or "registers") a top-level {@link identifier} (which takes a top-level scope name to use).
	 */
	public addTopLevelIdentifier(identifier: ts.Identifier | ts.DefaultKeyword): string {
		const symbol = getDeclarationNameSymbol(identifier, this.typeChecker);
		if (symbol === null) {
			throw new Error(`Something went wrong - cannot find a symbol for top-level identifier ${identifier.getText()} (from ${identifier.parent.parent.getText()})`);
		}

		const newLocalName = this.registerSymbol(symbol, identifier.getText());
		if (newLocalName === null) {
			throw new Error(`Something went wrong - a symbol ${symbol.name} for top-level identifier ${identifier.getText()} cannot be renamed`);
		}

		return newLocalName;
	}

	/**
	 * Returns a set of all already registered names for a given {@link symbol}.
	 */
	public namesForSymbol(symbol: ts.Symbol): Set<string> {
		return this.generatedNames.get(getActualSymbol(symbol, this.typeChecker)) || new Set();
	}

	/**
	 * Resolves given {@link referencedIdentifier} to a name.
	 * It assumes that a symbol for this identifier has been registered before by calling {@link addTopLevelIdentifier} method.
	 * Otherwise it will return `null`.
	 *
	 * Note that a returned value might be of a different type of the identifier (e.g. {@link ts.QualifiedName} for a given {@link ts.Identifier})
	 */
	public resolveReferencedIdentifier(referencedIdentifier: ts.Identifier): string | null {
		const identifierSymbol = getDeclarationNameSymbol(referencedIdentifier, this.typeChecker);
		if (identifierSymbol === null) {
			// that's fine if an identifier doesn't have a symbol
			// it could be in cases like for `prop` in `declare function func({ prop: prop3 }?: InterfaceName): TypeName;`
			return null;
		}

		const symbolScopePath = this.getSymbolScope(identifierSymbol);

		// this scope defines where the current identifier is located
		const currentIdentifierScope = this.getNodeScope(referencedIdentifier);

		if (symbolScopePath.length > 0 && currentIdentifierScope.length > 0 && symbolScopePath[0] === currentIdentifierScope[0]) {
			// if a referenced symbol is declared in the same scope where it is located
			// then just return its reference as is without any modification
			// also note that in this method we're working with identifiers only (i.e. it cannot be a qualified name)
			return referencedIdentifier.getText();
		}

		const topLevelIdentifierSymbol = symbolScopePath.length === 0 ? identifierSymbol : symbolScopePath[0];

		const namesForTopLevelSymbol = this.namesForSymbol(topLevelIdentifierSymbol);
		if (namesForTopLevelSymbol.size === 0) {
			return null;
		}

		let topLevelName = symbolScopePath.length === 0 ? referencedIdentifier.getText() : topLevelIdentifierSymbol.getName();
		if (!namesForTopLevelSymbol.has(topLevelName)) {
			// if the set of already registered names does not contain the one that is requested

			const topLevelNamesArray = Array.from(namesForTopLevelSymbol);

			// lets find more suitable name for a top level symbol
			let suitableTopLevelName = topLevelNamesArray[0];
			for (const name of topLevelNamesArray) {
				// attempt to find a generated name first to provide identifiers close to the original code as much as possible
				if (name.startsWith(`${topLevelName}$`)) {
					suitableTopLevelName = name;
					break;
				}
			}

			topLevelName = suitableTopLevelName;
		}

		const newIdentifierParts = [
			...symbolScopePath.map((symbol: ts.Symbol) => symbol.getName()),
			referencedIdentifier.getText(),
		];

		// we don't need to rename any symbol but top level only as only it can collide with other symbols
		newIdentifierParts[0] = topLevelName;

		return newIdentifierParts.join('.');
	}

	/**
	 * Similar to {@link resolveReferencedIdentifier}, but works with qualified names (Ns.Ns1.Interface).
	 * The main point of this resolver is that it might change the first part of the qualifier only (as it drives uniqueness of a name).
	 */
	public resolveReferencedQualifiedName(referencedIdentifier: ts.QualifiedName | ts.PropertyAccessEntityNameExpression): string | null {
		let topLevelIdentifier: ts.Identifier | ts.QualifiedName | ts.PropertyAccessEntityNameExpression = referencedIdentifier;

		if (ts.isQualifiedName(topLevelIdentifier) || ts.isPropertyAccessExpression(topLevelIdentifier)) {
			let leftmostIdentifier = ts.isQualifiedName(topLevelIdentifier) ? topLevelIdentifier.left : topLevelIdentifier.expression;

			while (ts.isQualifiedName(leftmostIdentifier) || ts.isPropertyAccessExpression(leftmostIdentifier)) {
				leftmostIdentifier = ts.isQualifiedName(leftmostIdentifier) ? leftmostIdentifier.left : leftmostIdentifier.expression;
			}

			topLevelIdentifier = leftmostIdentifier;
		}

		const topLevelName = this.resolveReferencedIdentifier(topLevelIdentifier);
		if (topLevelName === null) {
			// that's fine if we don't have a name for this top-level symbol
			// it simply means that this symbol type might not be supported for renaming
			// at this point the top-level identifier isn't registered yet
			// but it is possible that the full qualified name is registered so we can use its replacement instead
			// it is possible in cases where you use `import * as nsName` for internal modules
			// so `nsName.Interface` will be resolved to `Interface` (or any other name that `Interface` was registered with)
			const identifierSymbol = getDeclarationNameSymbol(referencedIdentifier, this.typeChecker);
			if (identifierSymbol === null) {
				// that's fine if an identifier doesn't have a symbol
				// it could be in cases like for `prop` in `declare function func({ prop: prop3 }?: InterfaceName): TypeName;`
				return null;
			}

			const namesForSymbol = this.namesForSymbol(identifierSymbol);
			if (namesForSymbol.size !== 0) {
				// if the set of already registered names contains the one that is requested then lets use it
				return Array.from(namesForSymbol)[0];
			}

			// if it is not registered - just skip it
			return null;
		}

		// for nodes that we have to import we need to add an imported value to the collisions map
		// so it will not overlap with other imports/inlined nodes
		const identifierParts = referencedIdentifier.getText().split('.');

		// update top level part as it could get renamed above
		// note that `topLevelName` might be a qualified name (e.g. with `.` in the name)
		// but this is fine as we join with `.` below anyway
		// but it is worth it to mention here ¯\_(ツ)_/¯
		identifierParts[0] = topLevelName;

		return identifierParts.join('.');
	}

	private getSymbolScope(identifierSymbol: ts.Symbol): ts.Symbol[] {
		const identifierDeclarations = getDeclarationsForSymbol(identifierSymbol);

		// not all symbols have declarations, e.g. `globalThis` or `undefined` (not type but value e.g. in `typeof undefined`)
		// they are "fake" symbols that exist only at the compiler level (see checker.ts file in in the compiler or `globals.set()` calls)
		if (identifierDeclarations.length === 0) {
			return [];
		}

		// we assume that all symbols for a given identifier will be in the same scope (i.e. defined in the same namespaces-chain)
		// so we can use any declaration to find that scope as they all will have the same scope
		return this.getNodeScope(identifierDeclarations[0]);
	}

	/**
	 * Returns a node's scope where it is located in terms of namespaces/modules.
	 * E.g. A scope for `Opt` in `declare module foo { type Opt = number; }` is `[Symbol(foo)]`
	 */
	private getNodeScope(node: ts.Node): ts.Symbol[] {
		const scopeIdentifiersPath: ts.Symbol[] = [];

		let currentNode: ts.Node = getClosestModuleLikeNode(node);
		while (ts.isModuleDeclaration(currentNode) && ts.isIdentifier(currentNode.name)) {
			const nameSymbol = getDeclarationNameSymbol(currentNode.name, this.typeChecker);
			if (nameSymbol === null) {
				throw new Error(`Cannot find symbol for identifier '${currentNode.name.getText()}'`);
			}

			scopeIdentifiersPath.push(nameSymbol);
			currentNode = getClosestModuleLikeNode(currentNode.parent);
		}

		return scopeIdentifiersPath.reverse();
	}

	private registerSymbol(identifierSymbol: ts.Symbol, preferredName: string): string | null {
		if (!renamingSupportedSymbols.some((flag: ts.SymbolFlags) => identifierSymbol.flags & flag)) {
			// if a symbol for something else that we don't support yet - skip
			verboseLog(`Symbol ${identifierSymbol.name} cannot be renamed because its flag (${identifierSymbol.flags}) isn't supported`);
			return null;
		}

		if (identifierSymbol.flags & ts.SymbolFlags.NamespaceModule && identifierSymbol.escapedName === ts.InternalSymbolName.Global) {
			// no need to rename `declare global` namespaces
			return null;
		}

		let symbolName = preferredName;
		if (symbolName === 'default') {
			// this is special case as an identifier cannot be named `default` because of es6 syntax
			// so lets fallback to some valid name
			symbolName = '_default';
		}

		const collisionsKey = symbolName;
		let collisionSymbols = this.collisionsMap.get(collisionsKey);
		if (collisionSymbols === undefined) {
			collisionSymbols = new Map();
			this.collisionsMap.set(collisionsKey, collisionSymbols);
		}

		const storedSymbolName = collisionSymbols.get(identifierSymbol);
		if (storedSymbolName !== undefined) {
			return storedSymbolName;
		}

		let nameIndex = collisionSymbols.size;
		let newName = collisionSymbols.size === 0 ? symbolName : `${symbolName}$${nameIndex}`;

		let resolvedGlobalSymbol = resolveGlobalName(this.typeChecker, newName);
		while (resolvedGlobalSymbol !== undefined && resolvedGlobalSymbol !== identifierSymbol) {
			nameIndex += 1;
			newName = `${symbolName}$${nameIndex}`;
			resolvedGlobalSymbol = resolveGlobalName(this.typeChecker, newName);
		}

		collisionSymbols.set(identifierSymbol, newName);

		let symbolNames = this.generatedNames.get(identifierSymbol);
		if (symbolNames === undefined) {
			symbolNames = new Set();
			this.generatedNames.set(identifierSymbol, symbolNames);
		}

		symbolNames.add(newName);

		return newName;
	}
}
