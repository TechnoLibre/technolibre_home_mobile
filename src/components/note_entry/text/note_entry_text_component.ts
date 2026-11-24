import { onMounted, onPatched, useRef, useState, xml } from "@odoo/owl";
import { Dialog } from "@capacitor/dialog";
import { EnhancedComponent } from "../../../js/enhancedComponent";
import { Events } from "../../../constants/events";

export class NoteEntryTextComponent extends EnhancedComponent {
	static template = xml`
		<div class="note-entry-text__wrapper">
			<textarea
				t-att-id="props.id"
				t-att-disabled="props.params.readonly ? true : false"
				class="note-entry__text"
				t-att-placeholder="t('placeholder.text')"
				t-att-aria-label="t('aria.text_entry')"
				t-ref="text"
				t-on-input="onInput"
			></textarea>
			<div class="note-entry-text__actions" t-if="props.params.text">
				<button
					type="button"
					class="note-entry-text__translate-btn"
					t-att-disabled="state.isTranslating"
					t-att-aria-busy="state.translatingTarget === 'en' ? 'true' : 'false'"
					t-att-aria-label="t('button.translate_fr_en')"
					t-on-click.stop.prevent="() => this.translateText('fr', 'en')"
				>
					<t t-if="state.translatingTarget === 'en'">…</t>
					<t t-else=""><t t-esc="t('button.translate_fr_en')"/></t>
				</button>
				<button
					type="button"
					class="note-entry-text__translate-btn"
					t-att-disabled="state.isTranslating"
					t-att-aria-busy="state.translatingTarget === 'fr' ? 'true' : 'false'"
					t-att-aria-label="t('button.translate_en_fr')"
					t-on-click.stop.prevent="() => this.translateText('en', 'fr')"
				>
					<t t-if="state.translatingTarget === 'fr'">…</t>
					<t t-else=""><t t-esc="t('button.translate_en_fr')"/></t>
				</button>
			</div>
			<div t-if="props.params.translation" class="note-entry-text__translation">
				<span class="note-entry-text__translation-lang"
				      t-esc="props.params.translationLang ? props.params.translationLang.toUpperCase() : ''"/>
				<p class="note-entry-text__translation-text" t-esc="props.params.translation"/>
			</div>
		</div>
	`;

	setup() {
		this.state = useState({
			isTranslating:     false,
			translatingTarget: null as "fr" | "en" | null,
		});
		onMounted(() => this.showText());
		onPatched(() => this.showText());
	}

	private textRef = useRef("text");

	/**
	 * The field's value, put in place after a render only when the text
	 * changed other than by typing (a pull, a merge, a transcription), with
	 * the text as it is then. Bound by t-model, a render computed before a
	 * keystroke and applied after it would put the older text back; written
	 * at every render, a word the keyboard is still composing, not yet an
	 * input event, would be lost.
	 */
	private showText() {
		const el = this.textRef.el as HTMLTextAreaElement | null;
		const text = this.props.params?.text ?? "";
		if (!el || text === this.shownText) return;
		this.shownText = text;
		if (el.value !== text) el.value = text;
	}

	/** The text the field last showed or sent: see showText. */
	private shownText: string | null = null;

	onInput(ev: Event) {
		this.shownText = (ev.target as HTMLTextAreaElement).value;
		this.props.params.text = this.shownText;
	}

	async translateText(source: "fr" | "en", target: "fr" | "en") {
		const text = this.props.params?.text;
		if (!text?.trim() || this.state.isTranslating) return;

		this.state.isTranslating     = true;
		this.state.translatingTarget = target;
		try {
			const translation = await this.translationService.translate(text, source, target);
			this.eventBus.trigger(Events.SET_ENTRY_TRANSLATION, {
				entryId: this.props.id,
				translation,
				targetLang: target,
				field: "text",
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			await Dialog.alert({
				message: this.t("error.translation_failed", { error: msg }),
			});
		} finally {
			this.state.isTranslating     = false;
			this.state.translatingTarget = null;
		}
	}
}
