import type { Context } from "telegraf";
import { ValidationError } from "../lib/errors.js";

export type TelegramMemberStatus =
  | "creator"
  | "administrator"
  | "member"
  | "restricted"
  | "left"
  | "kicked";

export interface TelegramAdminMember {
  userId: string;
  status: TelegramMemberStatus;
}

const ADMIN_STATUSES = new Set<TelegramMemberStatus>(["creator", "administrator"]);

export async function getTelegramMemberStatus(
  ctx: Context,
  chatId: string | number,
  userId: string | number
): Promise<TelegramMemberStatus> {
  try {
    const member = await ctx.telegram.getChatMember(chatId, Number(userId));
    return member.status as TelegramMemberStatus;
  } catch (error) {
    throw telegramVerificationError(error);
  }
}

export async function isTelegramGroupAdmin(
  ctx: Context,
  chatId: string | number,
  userId: string | number
): Promise<boolean> {
  const status = await getTelegramMemberStatus(ctx, chatId, userId);
  return ADMIN_STATUSES.has(status);
}

export async function assertTelegramGroupAdmin(
  ctx: Context,
  chatId: string | number,
  userId: string | number
): Promise<TelegramMemberStatus> {
  const status = await getTelegramMemberStatus(ctx, chatId, userId);

  if (!ADMIN_STATUSES.has(status)) {
    throw new ValidationError(
      "Only Telegram group creators or administrators can manage a group wallet. Ask a Telegram admin to run this command."
    );
  }

  return status;
}

export async function listTelegramGroupAdmins(
  ctx: Context,
  chatId: string | number
): Promise<TelegramAdminMember[]> {
  try {
    const admins = await ctx.telegram.getChatAdministrators(chatId);
    return admins.map(admin => ({
      userId: String(admin.user.id),
      status: admin.status as TelegramMemberStatus
    }));
  } catch (error) {
    throw telegramVerificationError(error);
  }
}

export function isAdminStatus(status: string | null | undefined): boolean {
  return status === "creator" || status === "administrator";
}

function telegramVerificationError(error: unknown): ValidationError {
  const message = error instanceof Error ? error.message : String(error);
  return new ValidationError(
    [
      "I could not verify Telegram admin status.",
      "Make the bot a group admin so it can manage this group wallet safely, then try again."
    ].join(" "),
    { cause: message }
  );
}
