export const ownerTopics = {
  approval: 'Jóváhagyás',
  why: 'Miért hozzád:',
  builtIn: {
    product_direction: { label: 'Termékirány', hint: 'Mit építsünk, mi maradjon ki, mi a fontosabb.' },
    cost: { label: 'Költség', hint: 'Pénz: előfizetés, fizetős szolgáltatás, keret.' },
    external_party: {
      label: 'Ügyfél vagy külső fél',
      hint: 'Ami ügyfélhez, partnerhez vagy a nyilvánossághoz jut el.',
    },
    risk_acceptance: {
      label: 'Kockázatvállalás',
      hint: 'Adatvesztés, biztonság vagy visszafordíthatatlan lépés vállalása.',
    },
    owner_only_setting: {
      label: 'Tulajdonosi beállítás',
      hint: 'Tagok és hozzáférésük, jogosultságok, jóváhagyási szabályok.',
    },
  },
} as const;
