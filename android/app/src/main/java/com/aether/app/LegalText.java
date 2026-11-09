package com.aether.app;

/** In-app plain-language policies. These do not invent an operator/contact address. */
final class LegalText {
    private LegalText() { }

    static final String DISCLAIMER =
            "Aether is designed for adults. By continuing, you confirm that you are at least 18 "
            + "or the age of majority where you live, whichever is higher.\n\n"
            + "Aether can produce inaccurate, incomplete, outdated, offensive, or unexpected material. "
            + "Fewer conversational restrictions do not make an answer true, safe, lawful, or suitable "
            + "for your circumstances. Verify important claims independently.\n\n"
            + "Do not rely on Aether for medical, legal, financial, employment, safety-critical, or "
            + "emergency decisions. Commands, code, files, websites, and generated media can have "
            + "real consequences. Review them before use.\n\n"
            + "Aether is provided without a promise of uninterrupted availability, accuracy, fitness "
            + "for a particular purpose, or preservation of third-party services. You are responsible "
            + "for how you use its output and for the prompts, files, keys, and instructions you supply.";

    static final String TERMS =
            "TERMS OF USE\n\n"
            + "1. Eligibility and acceptance\n"
            + "You must be an adult under the rule in the Disclaimer. Using Aether means you accept "
            + "these terms and the Privacy Policy.\n\n"
            + "2. Lawful, responsible use\n"
            + "Do not use Aether to break the law, violate another person's rights, exploit or harm "
            + "children, facilitate non-consensual intimate content, impersonate or defraud others, "
            + "distribute malware, gain unauthorized access, or interfere with services. Respect "
            + "copyright, confidentiality, contracts, website rules, and provider terms.\n\n"
            + "3. Your content and instructions\n"
            + "You retain responsibility for material you submit and actions you authorize. Do not "
            + "submit information you have no right to share. Confirm that commands and automations "
            + "are appropriate for the selected workspace and target.\n\n"
            + "4. Generated material\n"
            + "Output may resemble existing works or contain errors. Check originality, ownership, "
            + "licensing, and factual accuracy before publishing or relying on it. A source link is "
            + "not proof that a claim is correct.\n\n"
            + "5. Personal providers\n"
            + "Your provider account, charges, limits, and compliance are between you and that "
            + "provider. Aether does not guarantee a provider's models, availability, or conduct.\n\n"
            + "6. Availability and changes\n"
            + "Features, models, routes, and third-party integrations may change or stop. These "
            + "plain-language terms may be updated in later versions; the date shown in the app "
            + "identifies this revision.\n\n"
            + "7. Responsibility and remedies\n"
            + "To the extent permitted by applicable law, Aether's operator is not liable for "
            + "decisions or damages arising from generated material, commands, third-party services, "
            + "or misuse. Nothing here excludes rights or liabilities that cannot lawfully be excluded. "
            + "Stop using the app if you do not accept these terms.";

    static final String PRIVACY =
            "PRIVACY POLICY\n\n"
            + "Local information\n"
            + "Chat transcripts, attachments staged for a turn, settings, and personal-provider "
            + "metadata are stored in app-private storage on this device. Android backup is disabled "
            + "by the app manifest. Deleting a chat or clearing app data removes local information, "
            + "subject to the operating system's storage behavior.\n\n"
            + "Personal provider keys\n"
            + "Each saved key is encrypted with AES-GCM using a non-exportable Android Keystore key. "
            + "Provider metadata does not contain the plaintext key. There is no cloud sync or "
            + "server-side key vault in this Android implementation. A lost or invalidated Keystore "
            + "key can require you to enter the provider key again.\n\n"
            + "Built-in fleet\n"
            + "Built-in requests travel from the app to the configured fleet route. Fleet credentials "
            + "embedded in a private build are obfuscated, not securely extractable-proof; anyone who "
            + "obtains that APK may be able to recover them. Do not distribute a credential-bearing "
            + "build. Kaggle, Cloudflare, beacon services, and any model host process data under "
            + "their own terms and policies.\n\n"
            + "Personal providers\n"
            + "When selected, prompts, conversation history included in the request, readable "
            + "attachment text, model choice, and generation settings go directly from your device "
            + "to that provider. The provider's API key is sent to that provider for authentication. "
            + "Aether does not proxy this Android traffic through the web control server.\n\n"
            + "Tools and external content\n"
            + "Agent turns can contact search engines, websites, command targets, and media services "
            + "needed for the requested task. Those parties can observe network information and the "
            + "content sent to them. Discussion mode requests no tool use for that turn.\n\n"
            + "Diagnostics and reports\n"
            + "A report prepared in the app is not transmitted until you choose a sharing destination. "
            + "Review it before sharing and remove anything sensitive. No advertising identifier, "
            + "advertising SDK, analytics profile, or account system is added by this implementation.\n\n"
            + "Retention and control\n"
            + "You can delete individual chats, clear chat history, export chats without provider "
            + "keys, remove personal providers, or clear the app's Android storage. External services "
            + "may retain information under their own policies; local deletion cannot retract it.";

    static final String CONTENT =
            "CONTENT & RESPONSIBILITY\n\n"
            + "Aether is built to allow broad, adult conversation. That is not permission to cause "
            + "harm or ignore platform, provider, website, workplace, school, or legal rules.\n\n"
            + "Never use it for child sexual exploitation, non-consensual intimate imagery, credible "
            + "violence, targeted harassment, fraud, unauthorized surveillance, credential theft, or "
            + "instructions intended to cause real-world harm. Do not present generated material as "
            + "a human statement, verified evidence, or professional advice.\n\n"
            + "Research activity shows actions reported by the selected engine. A completed search, "
            + "opened page, or successful command does not prove that the final conclusion is correct. "
            + "Read the answer and its sources critically.\n\n"
            + "If something concerns you, use Legal → Prepare a concern report. The app creates a "
            + "local draft and lets you choose where to send it. Include the relevant answer and "
            + "circumstances, but do not add passwords, provider keys, or private documents.";

    static final String NOTICES =
            "Aether uses AndroidX, org.json, OpenAI-compatible provider APIs, and the services "
            + "configured in the build. Their names and marks belong to their respective owners. "
            + "Provider availability and model identifiers are supplied by those services; a saved "
            + "identifier is not a promise that the model is available.";
}
