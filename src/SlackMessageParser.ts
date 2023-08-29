import {ISlackMessageEvent} from "./BaseSlackHandler";
import * as Slackdown from "Slackdown";
import {TextualMessageEventContent} from "matrix-bot-sdk/lib/models/events/MessageEvent";
import substitutions from "./substitutions";

export class SlackMessageParser {
    private readonly handledSubtypes = [
        undefined, // Messages with no subtype
        "me_message",
        "bot_message",
        "file_comment",
        "message_changed",
    ];

    parse(message: ISlackMessageEvent): TextualMessageEventContent | null {
        const subtype = message.subtype;
        let text = message.text;
        if (!text) {
            return null;
        }

        if (!this.handledSubtypes.includes(subtype)) {
            return null;
        }

        if (subtype === "me_message") {
            return {
                msgtype: "m.emote",
                body: text,
            };
        }

        text = substitutions.slackToMatrix(text, subtype === "file_comment" ? message.file : undefined);
        const parsedMessage = this.parseText(text);

        if (subtype === "message_changed" && message.previous_message && message.previous_message.text) {
            const parsedPreviousMessage = this.parseText(message.previous_message.text);
            this.parseEdit(parsedMessage, parsedPreviousMessage);
        }

        return parsedMessage;
    }

    private parseEdit(parsedMessage: TextualMessageEventContent, parsedPreviousMessage: TextualMessageEventContent) {
        // TODO
    }

    private parseText(text: string): TextualMessageEventContent {
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
