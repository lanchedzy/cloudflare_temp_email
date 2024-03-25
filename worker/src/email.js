import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";

const PostalMime = require("postal-mime");
const simpleParser = require('mailparser').simpleParser;
global.setImmediate = (callback) => callback();

async function email(message, env, ctx) {
    if (env.BLACK_LIST && env.BLACK_LIST.split(",").some(word => message.from.includes(word))) {
        message.setReject("Missing from address");
        console.log(`Reject message from ${message.from} to ${message.to}`);
        return;
    }
    if (!env.PREFIX || (message.to && message.to.startsWith(env.PREFIX))) {
        const reader = message.raw.getReader();
        const decoder = new TextDecoder("utf-8");
        let rawEmail = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            rawEmail += decoder.decode(value);
        }

        let parsedEmail = {};
        try {
            parsedEmail = await simpleParser(rawEmail)
        } catch (error) {
            console.log(error)
        }

        if (!parsedEmail.html && !parsedEmail.textAsHtml && !parsedEmail.text) {
            console.log("Failed parse email, try postal-mime");
            const parser = new PostalMime.default();
            parsedEmail = await parser.parse(rawEmail);
        }

				let messageFrom = parsedEmail.from.text;
				let messageFromAddress = parsedEmail.from.value[0].address;
				let messageTo = parsedEmail.to.text;
				let result = parsedEmail.to.text.match(/<(.*)>/);
				if (result) {
					messageTo = result[0]
				}

				if (env.BLACK_LIST && env.BLACK_LIST.split(",").some(word => messageFrom.includes(word))) {
					message.setReject("Missing from address");
					console.log(`Reject message from ${messageFrom} to ${messageTo}`);
					return;
				}

        const { success } = await env.DB.prepare(
            `INSERT INTO mails (source, address, subject, message) VALUES (?, ?, ?, ?)`
        ).bind(
            messageFrom, messageTo,
            parsedEmail.subject || "",
            parsedEmail.html || parsedEmail.textAsHtml || parsedEmail.text || ""
        ).run();
        if (!success) {
            message.setReject(`Failed save message to ${messageTo}`);
            console.log(`Failed save message from ${messageFrom} to ${messageTo}`);
        }
        try {
            const results = await env.DB.prepare(
                `SELECT * FROM auto_reply_mails where address = ? and enabled = 1`
            ).bind(messageTo).first();
            if (results && results.source_prefix && messageFrom.startsWith(results.source_prefix)) {
                const msg = createMimeMessage();
                msg.setHeader("In-Reply-To", message.headers.get("Message-ID"));
                msg.setSender({
                    name: results.name || results.address,
                    addr: results.address
                });
                msg.setRecipient(message.from);
                msg.setSubject(results.subject || "Auto-reply");
                msg.addMessage({
                    contentType: 'text/plain',
                    data: results.message || "This is an auto-reply message, please reconact later."
                });

                const replyMessage = new EmailMessage(
                    message.to,
										message.from,
                    msg.asRaw()
                );
                await message.reply(replyMessage);
            }
        } catch (error) {
            console.log("reply email error", error);
        }
    } else {
        message.setReject(`Unknown address ${messageTo}`);
        console.log(`Unknown address ${messageTo}`);
    }
}

export { email }
