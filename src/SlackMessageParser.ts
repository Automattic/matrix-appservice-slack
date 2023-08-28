import {ISlackMessageEvent} from "./BaseSlackHandler";
import * as Slackdown from "Slackdown";
import {TextualMessageEventContent} from "matrix-bot-sdk/lib/models/events/MessageEvent";

export class SlackMessageParser {
    async parse(event: ISlackMessageEvent): Promise<TextualMessageEventContent | null> {
        const subtype = event.subtype;

        const isText = [undefined, "bot_message", "file_comment"].includes(subtype);
        if (isText) {
            return await this.parseText(event.text || "");
        }

        if (subtype === "me_message" && event.text) {
            return {
                msgtype: "m.emote",
                body: event.text,
            };
        }

        return null;
    }

    private async parseText(text: string): Promise<TextualMessageEventContent> {
        // TODO: This is fixing plaintext mentions, but should be refactored.
        // https://github.com/matrix-org/matrix-appservice-slack/issues/110
        const body = text.replace(/<https:\/\/matrix\.to\/#\/@.+:.+\|(.+)>/g, "$1");

        // TODO: Slack's markdown is their own thing that isn't really markdown,
        // but the only parser we have for it is slackdown. However, Matrix expects
        // a variant of markdown that is in the realm of sanity. Currently text
        // will be slack's markdown until we've got a slack -> markdown parser.
        let formattedBody: string = Slackdown.parse(text);

        // Parse blockquotes.
        const blocks: string[] = [];
        let currentQuote = "";
        const quoteDelimiter = "> ";
        for (const line of formattedBody.split("\n")) {
            if (line.startsWith(quoteDelimiter)) {
                currentQuote += line.replace(quoteDelimiter, "") + "<br>";
            } else {
                if (currentQuote !== "") {
                    blocks.push(`<blockquote>${currentQuote}</blockquote>`);
                }
                blocks.push(`${line}<br>`);
                currentQuote = "";
            }
        }
        if (currentQuote !== "") {
            blocks.push(`<blockquote>${currentQuote}</blockquote>`);
        }

        if (blocks.length > 0) {
            formattedBody = blocks.join("");
        }
        formattedBody = formattedBody.replace("\n", "<br>");

        return {
            msgtype: "m.text",
            format: "org.matrix.custom.html",
            body,
            formatted_body: formattedBody,
        };
    }
}
