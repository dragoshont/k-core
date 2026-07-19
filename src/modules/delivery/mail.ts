import nodemailer from "nodemailer";
import type { AppConfig } from "../config";

export interface MailSubmission {
	attachmentPath: string;
	destination: string;
	messageId: string;
	title: string;
}

export interface MailResult {
	accepted: boolean;
	response: string;
}

export interface MailSender {
	ready(): boolean;
	send(input: MailSubmission): Promise<MailResult>;
}

export function createMailSender(config: AppConfig): MailSender {
	if (!config.smtpHost || !config.smtpFrom) {
		return { ready: () => false, async send() { throw new Error("SMTP is not configured"); } };
	}
	const transporter = nodemailer.createTransport({
		host: config.smtpHost,
		port: config.smtpPort ?? 587,
		secure: (config.smtpPort ?? 587) === 465,
		...(config.smtpUser && config.smtpPassword ? { auth: { pass: config.smtpPassword, user: config.smtpUser } } : {}),
	});
	return {
		ready: () => true,
		async send(input) {
			const result = await transporter.sendMail({
				attachments: [{ filename: `${input.title.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 80) || "book"}.epub`, path: input.attachmentPath }],
				from: config.smtpFrom,
				messageId: input.messageId,
				subject: input.title,
				text: "Prepared by k.",
				to: input.destination,
			});
			return { accepted: result.accepted.length > 0, response: String(result.response ?? "") };
		},
	};
}