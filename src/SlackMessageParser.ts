import {ISlackMessageEvent} from "./BaseSlackHandler";
import * as Slackdown from "Slackdown";
import {TextualMessageEventContent} from "matrix-bot-sdk/lib/models/events/MessageEvent";
import substitutions from "./substitutions";
import {IMatrixReplyEvent} from "./SlackGhost";

export class SlackMessageParser {
    private readonly handledSubtypes = [
        undefined, // Messages with no subtype
        "me_message",
        "bot_message",
        "file_comment",
        "message_changed",
    ];

    constructor(private matrixRoomId: string) {}

    parse(message: ISlackMessageEvent, replyEvent: IMatrixReplyEvent | null): TextualMessageEventContent | null {
        const subtype = message.subtype;
        if (!this.handledSubtypes.includes(subtype)) {
            return null;
        }

        let text = message.text;
        if (!text) {
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
            return this.parseEdit(parsedMessage, parsedPreviousMessage, replyEvent);
        }

        return parsedMessage;
    }

    private parseEdit(
        parsedMessage: TextualMessageEventContent,
        parsedPreviousMessage: TextualMessageEventContent,
        replyEvent: IMatrixReplyEvent | null
    ) {
        const edits  = substitutions.makeDiff(parsedPreviousMessage.body, parsedMessage.body);
        const prev   = substitutions.htmlEscape(edits.prev);
        const curr   = substitutions.htmlEscape(edits.curr);
        const before = substitutions.htmlEscape(edits.before);
        const after  = substitutions.htmlEscape(edits.after);

        let body =
            `(edited) ${edits.before} ${edits.prev} ${edits.after} => ` +
            `${edits.before} ${edits.curr} ${edits.after}`;

        let formattedBody =
            `<i>(edited)</i> ${before} <font color="red"> ${prev} </font> ${after} =&gt; ${before}` +
            `<font color="green"> ${curr} </font> ${after}`;

        let newBody = parsedMessage.body;
        let newFormattedBody =  parsedMessage.formatted_body;

        if (replyEvent) {
            const bodyFallback = this.getFallbackText(replyEvent);
            const formattedFallback = this.getFallbackHtml(this.matrixRoomId, replyEvent);
            body = `${bodyFallback}\n\n${body}`;
            formattedBody = formattedFallback + formattedBody;
            newBody = bodyFallback + parsedMessage.body;
            newFormattedBody = formattedFallback + parsedMessage.formatted_body;
        }

        return {
            msgtype: "m.text",
            format: "org.matrix.custom.html",
            body,
            formatted_body: formattedBody,
            "m.new_content": {
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: newBody,
                formatted_body: newFormattedBody,
            }
        };
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

    private getFallbackHtml(roomId: string, replyEvent: IMatrixReplyEvent): string {
        const originalBody = (replyEvent.content ? replyEvent.content.body : "") || "";
        let originalHtml = (replyEvent.content ? replyEvent.content.formatted_body : "") || null;
        if (originalHtml === null) {
            originalHtml = originalBody;
        }
        return "<mx-reply><blockquote>"
            + `<a href="https://matrix.to/#/${roomId}/${replyEvent.event_id}">In reply to</a>`
            + `<a href="https://matrix.to/#/${replyEvent.sender}">${replyEvent.sender}</a>`
            + `<br />${originalHtml}`
            + "</blockquote></mx-reply>";
    }

    private getFallbackText(replyEvent: IMatrixReplyEvent): string {
        const originalBody = (replyEvent.content ? replyEvent.content.body : "") || "";
        return `> <${replyEvent.sender}> ${originalBody.split("\n").join("\n> ")}`;
    }
}
