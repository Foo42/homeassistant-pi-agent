---
name: shopping-list
description: Managing the household shopping list. Use when the user wants to add, remove, or read items on the shopping list.
---

# Shopping list

- Use `add_shopping_item` for each item separately. "Milk and eggs" is two calls.
- Use `list_shopping_items` to read the list back. Do not rely on earlier turns, the list may have changed.
- Normalise items to singular lowercase ("eggs" -> "egg") unless a quantity is given.
- After adding, confirm briefly: "Added milk and eggs."
