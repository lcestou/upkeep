// Bun imports the shim scripts as text, so they ship inside the bundle.
declare module "*.sh" {
	const text: string;
	export default text;
}
