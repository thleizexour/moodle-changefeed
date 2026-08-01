import { parseMoodleIcs } from "./parse.mjs";

export { parseMoodleIcs };

export class MoodleIcsAdapter {
  constructor({ credentialProvider, fetchImpl = globalThis.fetch, text = null } = {}) {
    this.credentialProvider = credentialProvider;
    this.fetchImpl = fetchImpl;
    this.text = text;
  }

  async collect({ text = this.text } = {}) {
    if (typeof text === "string") return parseMoodleIcs(text);
    if (typeof this.credentialProvider?.getIcsUrl !== "function") return [];
    const privateUrl = await this.credentialProvider.getIcsUrl();
    if (!privateUrl) return [];
    let url;
    try {
      url = new URL(privateUrl);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch {
      throw new Error("Moodle ICS credential is invalid");
    }
    let response;
    try {
      response = await this.fetchImpl(url.toString(), { redirect: "manual" });
    } catch {
      throw new Error("Moodle ICS request failed");
    }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      !response.ok
    ) {
      throw new Error("Moodle ICS request rejected");
    }
    return parseMoodleIcs(await response.text());
  }
}
