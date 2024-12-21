/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Wait for the deviceready event before using any of Cordova's device APIs.
// See https://cordova.apache.org/docs/en/latest/cordova/events/events.html#deviceready
document.addEventListener('deviceready', onDeviceReady, false);

function onDeviceReady() {
    // Cordova is now initialized. Have fun!

    console.log('Running cordova-' + cordova.platformId + '@' + cordova.version);
    document.getElementById('deviceready').classList.add('ready');
}

document.addEventListener('deviceready', onDeviceReady, false);

function onDeviceReady() {
  // Lire l'URL de la page web depuis le fichier config.json
  fetch('config.json')
    .then(response => response.json())
    .then(config => {
      const webpageUrl = config.webpageUrl;

      // Ajouter un écouteur d'événement à un bouton (ou tout autre élément)
      document.getElementById('monBouton').addEventListener('click', function() {
        // Rediriger vers la page web
        window.open(webpageUrl, '_system');
      });

      // Ajout de contact lors du clic du bouton associé
      document.getElementById('btn-ajout-contact').addEventListener('click', function () {
        // Demander à l'utilisateur s'il souhaite réellement ajouter le contact.
        // Si l'utilisateur confirme, ajouter le contact à la liste.
        navigator.notification.confirm(
          "Ajouter le contact?",
          onAjouterContactConfirm,
          "Confirmation requise",
          ["Ok", "Annuler"]
        );
      });
    });
}

function onAjouterContactConfirm(buttonIndex) {
  var indexBtnOk = 1;
  if (buttonIndex !== indexBtnOk) {
    return;
  }
  try {
    // Ajouter le contact
    console.log("Creating contact variable");
    var contact = navigator.contacts.create({
      displayName: "RobotLibre",
      phoneNumbers: [
        new ContactField(
          "Compagnie",
          "514-555-5555",
          true
        )
      ],
      emails: [
        new ContactField(
          "Compagnie",
          "robotlibre@technolibre.ca",
          true
        )
      ],
      photos: [
        new ContactField(
          "Photo de profil",
          "https://technolibre.ca/web/image/website/1/favicon/",
          true
        )
      ]
    });
    console.log("Saving contact");
    contact.save();
    console.log("After contact save")
  } catch (error) {
    console.error(error);
  }
  
}