import { BrowserWindow } from "electrobun/main";

export const mainWindow = new BrowserWindow({
	title: "Upkeep",
	url: "views://mainview/index.html",
	frame: { width: 980, height: 720, x: 200, y: 120 },
});
