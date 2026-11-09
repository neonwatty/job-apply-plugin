## Field Mapping Reference

| Profile Field | Common Form Labels |
|--------------|-------------------|
| firstName | First Name, Given Name, First |
| lastName | Last Name, Family Name, Surname, Last |
| email | Email, Email Address, E-mail |
| phone | Phone, Phone Number, Mobile, Cell |
| location.city | City |
| location.state | State, Province, State/Province |
| location.zip | Zip, Postal Code, ZIP Code |
| location.country | Country |
| linkedInUrl | LinkedIn, LinkedIn URL, LinkedIn Profile |
| workHistory[0].company | Current Company, Most Recent Employer, Company |
| workHistory[0].title | Current Title, Job Title, Position, Title |
| education[0].school | School, University, College, Institution |
| education[0].degree | Degree, Degree Type |
| education[0].field | Major, Field of Study, Concentration |

For recurring application questions, classify "Have you ever worked here
before?", "Are you a former employee?", and employer-named variants as
`prior_employment`. Match a confirmed generic `{}` answer only when the owner's
stated rule applies to the employer and the live wording does not broaden the
question (for example, to contractor or any-capacity work). Use the observed
employer as a narrower scope when the answer is employer-specific. Do not label
these questions `employment_history`; that would prevent reuse of the saved
prior-employment answer.

For a U.S. veteran-status menu, use the accepted answer's structured
`answerIntent.status` when present. Map `not_a_veteran` only to an option that
explicitly says the applicant is not a veteran; map
`veteran_not_protected` only to an option that explicitly says the applicant
is a veteran but not protected; map `protected_veteran` only to an explicitly
protected-veteran option; and map `decline_to_identify` only to a decline or
prefer-not-to-answer option. Read the live option text and verify the selected
state. If the record has no structured intent, a phrase such as “not a
protected veteran” is insufficient to choose between veteran and non-veteran
options: ask the owner once, save the precise answer with permission, then
resume. A matched question alias is evidence about the question, not proof
that an option has the same meaning.

---
