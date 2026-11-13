/** Relations between cards (PM-192), named from the side of the card that shows them. */
export const relations = {
  kinds: {
    part_of: 'Gyűjtőkártya',
    has_part: 'Alkártyái',
    prerequisite: 'Előtte kell',
    prerequisite_of: 'Utána jön',
    related: 'Kapcsolódik',
    duplicate_of: 'Duplikátuma',
    duplicated_by: 'Duplikátumai',
  },
} as const;
