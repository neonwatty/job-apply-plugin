### Ashby

**Characteristics:**
- Simple single-page form
- Fields: name, phone, email, location (combobox), LinkedIn URL, resume upload
- Has both a resume upload field and a separate autofill file input — use the resume field, not the autofill one

**Approach (visible browser first):**
1. Navigate to the URL in the host-managed visible browser
2. Read the visible form structure
3. Fill text fields (name, phone, email, LinkedIn URL)
4. **Location combobox**: Type the location to trigger suggestions, then click the matching option
5. **Resume upload**: Use the resume field, not the separate autofill file input, and verify the filename
6. Review all visible values
7. Stop before the final action, give a value-free field-name/status summary, and let the user submit manually
