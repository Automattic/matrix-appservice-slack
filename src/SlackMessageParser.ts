import {ISlackEventMessageAttachment, ISlackMessageEvent, ISlackFile} from "./BaseSlackHandler";
import * as Slackdown from "Slackdown";
import {TextualMessageEventContent} from "matrix-bot-sdk/lib/models/events/MessageEvent";
import substitutions, {getFallbackForMissingEmoji} from "./substitutions";
import {IMatrixReplyEvent} from "./SlackGhost";
import {WebClient} from "@slack/web-api";
import {SlackRoomStore} from "./SlackRoomStore";
import {Intent, Logger} from "matrix-appservice-bridge";
import {ConversationsInfoResponse} from "./SlackResponses";
import {Datastore} from "./datastore/Models";
import {SlackGhostStore} from "./SlackGhostStore";
import {Main} from "./Main";
import * as emoji from "node-emoji";

const CHANNEL_ID_REGEX = /<#(\w+)\|?\w*?>/g;

// If the message is an emote, the format is <@ID|nick>, but in normal messages it's just <@ID>.
const USER_ID_REGEX = /<@(\w+)\|?\w*?>/g;

const log = new Logger("SlackMessageParser");

/**
 * Parses the content of a Slack message into an `m.message` Matrix event.
 */
export class SlackMessageParser {
    private readonly handledSubtypes = [
        undefined, // Messages with no subtype
        "me_message",
        "bot_message",
        "file_comment",
        "message_changed",
    ];

    constructor(
        private readonly matrixRoomId: string,
        private readonly matrixBotIntent: Intent,
        private readonly datastore: Datastore,
        private readonly roomStore: SlackRoomStore,
        private readonly ghostStore: SlackGhostStore,
        // Main is only for getTeamDomainForMessage()
        // TODO: Refactor getTeamDomainForMessage() into something that can be injected.
        //       Also, there are currently two implementations of getTeamDomainForMessage() in the codebase.
        //       There should be a single one.
        private readonly main: Main,
    ) {}

    async parse(
        message: ISlackMessageEvent,
        slackClient: WebClient,
        replyEvent: IMatrixReplyEvent | null,
    ): Promise<TextualMessageEventContent | null> {
        const subtype = message.subtype;
        if (!this.handledSubtypes.includes(subtype)) {
            return null;
        }

        if (subtype === "me_message") {
            return {
                msgtype: "m.emote",
                body: message.text || "",
            };
        }

        let text = "";
        if (message.attachments) {
            for (const attachment of message.attachments) {
                text += this.parseAttachment(attachment);
            }
        } else {
            text = message.text || "";
        }

        if (text === "") {
            return null;
        }

        if (subtype === "file_comment" && message.file) {
            text = this.replaceFileLinks(text, message.file);
        }

        const teamDomain = await this.main.getTeamDomainForMessage(message);
        const parsedMessage = await this.doParse(text, slackClient, message.channel, teamDomain);

        if (subtype === "message_changed" && message.previous_message?.text) {
            const parsedPreviousMessage = await this.doParse(message.previous_message.text, slackClient, message.channel, teamDomain);
            return this.parseEdit(parsedMessage, parsedPreviousMessage, replyEvent);
        }

        return parsedMessage;
    }

    private parseAttachment(attachment: ISlackEventMessageAttachment): string {
        let text = attachment.fallback;
        if (attachment.text) {
            text = `${text}: ${attachment.text}`;
            if (attachment.title_link) {
                text = `${text} [${attachment.title_link}]`;
            }
        }

        return text;
    }

    private async doParse(
        body: string,
        slackClient: WebClient,
        channelId: string,
        teamDomain: string | undefined,
    ): Promise<TextualMessageEventContent> {
        body = await this.replaceChannelIdsWithNames(body, slackClient);
        if (teamDomain) {
            body = await this.replaceUserIdsWithNames(body, teamDomain, channelId);
        }

        body = body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        body = body.replace("<!channel>", "@room");
        body = body.replace("<!here>", "@room");
        body = body.replace("<!everyone>", "@room");
        body = emoji.emojify(body, getFallbackForMissingEmoji);

        // TODO: This is fixing plaintext mentions, but should be refactored.
        // https://github.com/matrix-org/matrix-appservice-slack/issues/110
        body = body.replace(/<https:\/\/matrix\.to\/#\/@.+:.+\|(.+)>/g, "$1");

        // TODO: Slack's markdown is their own thing that isn't really markdown,
        // but the only parser we have for it is slackdown. However, Matrix expects
        // a variant of markdown that is in the realm of sanity. Currently text
        // will be slack's markdown until we've got a slack -> markdown parser.
        let formattedBody: string = Slackdown.parse(body);

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

    private async replaceChannelIdsWithNames(text: string, slackClient: WebClient): Promise<string> {
        let match: RegExpExecArray | null = null;
        while ((match = CHANNEL_ID_REGEX.exec(text)) !== null) {
            // foreach channelId, pull out the ID
            // (if this is an emote msg, the format is <#ID|name>, but in normal msgs it's just <#ID>
            const id = match[1];

            // Lookup the room in the store.
            let room = this.roomStore.getBySlackChannelId(id);

            // If we bridge the room, attempt to look up its canonical alias.
            if (room !== undefined) {
                const canonicalEvent = await this.matrixBotIntent.getStateEvent(room.MatrixRoomId, "m.room.canonical_alias", "", true);
                const canonicalAlias = canonicalEvent?.alias;
                if (canonicalAlias) {
                    text = text.slice(0, match.index) + canonicalAlias + text.slice(match.index + match[0].length);
                    log.debug(`Room ${room.MatrixRoomId} does not have a canonical alias`);
                } else {
                    room = undefined;
                }
            }

            // If we can't match the room then we just put the Slack name
            if (room === undefined) {
                const name = await this.getSlackRoomNameFromID(id, slackClient);
                text = text.slice(0, match.index) + `#${name}` + text.slice(match.index + match[0].length);
            }
        }
        return text;
    }

    private async replaceUserIdsWithNames(text: string, teamDomain: string, channelId: string): Promise<string> {
        let match: RegExpExecArray|null = null;
        while ((match = USER_ID_REGEX.exec(text)) !== null) {
            // foreach userId, pull out the ID
            // (if this is an emote msg, the format is <@ID|nick>, but in normal msgs it's just <@ID>
            const id = match[1];

            let displayName = "";
            const userId = await this.ghostStore.getUserId(id, teamDomain);

            const users = await this.datastore.getUser(userId);

            if (!users) {
                log.warn("Mentioned user not in store. Looking up display name from slack.");
                // if the user is not in the store then we look up the displayname
                displayName = await this.ghostStore.getNullGhostDisplayName(channelId, id);
                // If the user is not in the room, we can't pills them, we have to just plain text mention them.
                text = text.slice(0, match.index) + displayName + text.slice(match.index + match[0].length);
            } else {
                displayName = users.display_name || userId;
                text = text.slice(0, match.index) + `<https://matrix.to/#/${userId}|${displayName}>` + text.slice(match.index + match[0].length);
            }
        }
        return text;
    }

    private async getSlackRoomNameFromID(channel: string, client: WebClient): Promise<string> {
        try {
            const response = (await client.conversations.info({ channel })) as ConversationsInfoResponse;
            if (response && response.channel && response.channel.name) {
                log.info(`conversations.info: ${channel} mapped to ${response.channel.name}`);
                return response.channel.name;
            }
            log.info("conversations.info returned no result for " + channel);
        } catch (err) {
            log.error("Caught error handling conversations.info:" + err);
        }
        return channel;
    }

    private replaceFileLinks(text: string, file: ISlackFile): string {
        if (!file.permalink_public || !file.url_private || !file.permalink) {
            return text;
        }

        const pubSecret = file.permalink_public.match(/https?:\/\/slack-files.com\/[^-]*-[^-]*-(.*)/);
        if (!pubSecret || pubSecret.length === 0) {
            return text;
        }

        return text.replace(file.permalink, `${file.url_private}?pub_secret=${pubSecret[1]}`);
    }
}
