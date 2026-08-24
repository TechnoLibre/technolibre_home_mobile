//! Compteur de mots en une passe, sans allocation par mot.
//!
//! Le point intéressant : `split_whitespace` sur `&str` rend des tranches qui
//! empruntent l'entrée, donc rien n'est copié tant qu'on ne les met pas dans
//! la table. La clé est allouée une seule fois, à la première rencontre.

use std::collections::HashMap;
use std::io::{self, Read};

/// Compte les mots, en repliant la casse.
pub fn compter(texte: &str) -> HashMap<String, usize> {
    let mut table: HashMap<String, usize> = HashMap::new();
    for brut in texte.split_whitespace() {
        let mot: String = brut
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '\'')
            .flat_map(|c| c.to_lowercase())
            .collect();
        if mot.is_empty() {
            continue;
        }
        *table.entry(mot).or_insert(0) += 1;
    }
    table
}

/// Les `n` mots les plus fréquents, à égalité départagée par ordre alphabétique.
pub fn plus_frequents(table: &HashMap<String, usize>, n: usize) -> Vec<(&str, usize)> {
    let mut v: Vec<(&str, usize)> = table.iter().map(|(k, &c)| (k.as_str(), c)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    v.truncate(n);
    v
}

fn main() -> io::Result<()> {
    let mut entree = String::new();
    io::stdin().read_to_string(&mut entree)?;
    let table = compter(&entree);
    for (mot, n) in plus_frequents(&table, 10) {
        println!("{n:6}  {mot}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replie_la_casse_et_la_ponctuation() {
        let t = compter("Chat, chat; CHAT chien.");
        assert_eq!(t.get("chat"), Some(&3));
        assert_eq!(t.get("chien"), Some(&1));
    }

    #[test]
    fn garde_l_apostrophe() {
        let t = compter("l'été l'été");
        assert_eq!(t.get("l'été"), Some(&2));
    }

    #[test]
    fn departage_a_egalite() {
        let t = compter("b a");
        assert_eq!(plus_frequents(&t, 2), vec![("a", 1), ("b", 1)]);
    }
}
