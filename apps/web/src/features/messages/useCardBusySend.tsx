import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { CardBusyDetails, SendTeamMessageRequest, TeamMessage } from '@projectman/shared';
import { useSendTeamMessage } from '../../api/queries';
import { CardBusyWarning, refusedCardBusy } from './CardBusyWarning';

/** What the sender stepped back with: nothing was sent and there is nothing to show. */
export class CardBusyDeclined extends Error {
  constructor() {
    super('The sender stepped back from a busy card');
    this.name = 'CardBusyDeclined';
  }
}

interface Asked {
  details: CardBusyDetails;
  body: SendTeamMessageRequest;
  resolve: (message: TeamMessage) => void;
  reject: (error: unknown) => void;
}

/**
 * The send of a team message from the web (PM-663). A 409 `card_busy` opens the confirmation instead
 * of failing: `send` stays pending until the sender sends anyway (it resolves with the message) or
 * steps back (it rejects with `CardBusyDeclined`, which needs no error text). Any other failure,
 * also that of the resend, rejects with the error and shows in `mutation.error` as before.
 * Render `dialog` next to the message box; `returnFocus` finds the message box the focus goes back to.
 */
export function useCardBusySend(key: string, returnFocus?: () => HTMLElement | null) {
  const mutation = useSendTeamMessage(key);
  const { mutateAsync, reset } = mutation;
  const [asked, setAsked] = useState<Asked | null>(null);

  const send = useCallback(
    (body: SendTeamMessageRequest): Promise<TeamMessage> =>
      mutateAsync(body).catch((error: unknown) => {
        const details = refusedCardBusy(error);
        if (!details) throw error;
        // The refusal is a question, not a failure: no error text under the message box.
        reset();
        return new Promise<TeamMessage>((resolve, reject) => setAsked({ details, body, resolve, reject }));
      }),
    [mutateAsync, reset],
  );

  const dialog: ReactNode = asked ? (
    <CardBusyWarning
      details={asked.details}
      loading={mutation.isPending}
      returnFocus={returnFocus}
      onBack={() => {
        setAsked(null);
        asked.reject(new CardBusyDeclined());
      }}
      onConfirm={() =>
        void mutateAsync({ ...asked.body, despiteWorkers: true }).then(
          (message) => {
            setAsked(null);
            asked.resolve(message);
          },
          (error: unknown) => {
            setAsked(null);
            asked.reject(error);
          },
        )
      }
    />
  ) : null;

  return { mutation, send, dialog };
}
